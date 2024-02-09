const _ = require('lodash/fp');
const chain = require('fn-one');
const fn = require('fn-tester');
const { is } = require('./helper');
const rel = require('./components/rel')();

const fnComp = function (knex, tablePrefix = '') {
    is.valid(is.object, is.maybeString, arguments);
    var comps = {};
    const compProps = { name: is.string, data: is.func, schema: is.func };

    function compact(compData) {
        is.valid(is.object, arguments);
        return _.pickBy((v) => !_.isUndefined(v))(compData);
    }

    function getColumnNames(compData) {
        is.valid(is.object, arguments);
        let colNames = {};
        _.each((k) => (colNames[_.camelCase(k)] = k))(_.keys(compData));
        return colNames;
    }

    async function insertRecord(compName, compData, trx = knex) {
        is.valid(is.string, is.object, is.maybeObject, arguments);
        return trx(tablePrefix + compName)
            .insert(compact(compData))
            .returning('id')
            .then(_.flow(_.head, _.get('id')));
    }

    async function selectRecords(compName, compData, trx = knex, offset = 0, limit = 10) {
        is.valid(is.string, is.object, is.maybeObject, is.maybeNumber, is.maybeNumber, arguments);
        return trx(tablePrefix + compName)
            .select()
            .columns(getColumnNames(compData))
            .where(compact(compData))
            .orderBy('id')
            .offset(offset)
            .limit(limit);
    }

    async function checkRelSources(relSources, trx = knex) {
        is.valid(is.maybeArray, is.maybeObject, arguments);
        const sourcePromises = _.map((v) => selectRecords(v.name, v.data(), trx))(relSources);
        const sourceRecs = await Promise.all(sourcePromises);
        const numSourcesReturned = _.flow(_.compact, _.get('length'))(sourceRecs);
        if (numSourcesReturned < _.get('length')(relSources)) {
            throw new Error('Missing relation sources.');
        }
    }

    async function insertUpstreamRels(relSources, targetComp, targetId, trx = knex) {
        is.valid(is.maybeArray, is.maybeString, is.maybeNumber, is.maybeObject, arguments);
        let promises = [];
        _.each((relSource) => {
            let relComp = rel(undefined, relSource.name, _.get('id')(relSource.data()), targetComp, targetId);
            promises.push(() =>
                fn
                    .run(selectRecords, null, relComp.name, relComp.data(), trx)
                    .then((result) =>
                        _.head(result) ? false : fn.run(insertRecord, null, relComp.name, relComp.data(), trx)
                    )
            );
        })(relSources);
        for (let p in promises) {
            await promises[p]();
        }
        return targetId;
    }

    async function insertDownstreamRels(relTargets, sourceComp, sourceId, trx = knex) {
        is.valid(is.maybeArray, is.maybeString, is.maybeNumber, is.maybeObject, arguments);
        let promises = [];
        _.each((relTarget) => {
            let relComp = rel(undefined, sourceComp, sourceId, relTarget.name, _.get('id')(relTarget.data()));
            promises.push(() =>
                fn
                    .run(selectRecords, null, relComp.name, relComp.data(), trx)
                    .then((result) =>
                        _.head(result) ? false : fn.run(insertRecord, null, relComp.name, relComp.data(), trx)
                    )
            );
        })(relTargets);
        for (let p in promises) {
            await promises[p]();
        }
        return sourceId;
    }

    async function getUpstreamRecords(comp, rootCompName, result = {}, selectRecordsFunc = selectRecords) {
        is.valid(is.objectWithProps(compProps), is.string, is.maybeObject, is.maybeFunc, arguments);
        const compRecs = await selectRecordsFunc(comp.name, comp.data());
        if (!result[comp.name]) {
            result[comp.name] = [];
        }
        for (let i = 0, cLen = compRecs.length; i < cLen; i++) {
            result[comp.name].push({ self: compRecs[i] });

            let relComp = rel(undefined, undefined, undefined, comp.name, compRecs[i].id);
            let relRecs = await selectRecordsFunc(relComp.name, relComp.data());

            for (let j = 0, rLen = relRecs.length; j < rLen; j++) {
                let relRec = relRecs[j];
                if (relRec.sourceComp === rootCompName) {
                    continue;
                }

                let sourceComp = comps[relRec.sourceComp](relRec.sourceId);
                result[comp.name][i] = await getUpstreamRecords(
                    sourceComp,
                    rootCompName,
                    result[comp.name][i],
                    selectRecordsFunc
                );
            }
        }
        return result;
    }

    async function getDownstreamRecords(comp, rootCompName, result = {}, selectRecordsFunc = selectRecords) {
        is.valid(is.objectWithProps(compProps), is.string, is.maybeObject, is.maybeFunc, arguments);
        const compRecs = await selectRecordsFunc(comp.name, comp.data());
        if (!result[comp.name]) {
            result[comp.name] = [];
        }
        for (let i = 0, cLen = compRecs.length; i < cLen; i++) {
            result[comp.name].push({ self: compRecs[i] });

            let relComp = rel(undefined, comp.name, compRecs[i].id);
            let relRecs = await selectRecordsFunc(relComp.name, relComp.data());

            for (let j = 0, rLen = relRecs.length; j < rLen; j++) {
                let relRec = relRecs[j];
                if (relRec.targetComp === rootCompName) {
                    continue;
                }

                let targetComp = comps[relRec.targetComp](relRec.targetId);
                result[comp.name][i] = await getDownstreamRecords(
                    targetComp,
                    rootCompName,
                    result[comp.name][i],
                    selectRecordsFunc
                );
            }
        }
        return result;
    }

    this.create = async function create(comp, upstreamRelSources = [], downstreamRelTargets = []) {
        is.valid(is.objectWithProps(compProps), is.maybeArray, is.maybeArray, arguments);
        return await knex.transaction(
            async (trx) =>
                await chain(
                    () => fn.run(checkRelSources, null, _.concat(upstreamRelSources, downstreamRelTargets), trx),
                    () => fn.run(insertRecord, null, comp.name, comp.data(), trx),
                    (id) => fn.run(insertUpstreamRels, null, upstreamRelSources, comp.name, id, trx),
                    (id) => fn.run(insertDownstreamRels, null, downstreamRelTargets, comp.name, id, trx)
                )
        );
    };

    this.get = async function get(comp, filters = {}) {
        function removeDuplicates(result, compName) {
            is.valid(is.maybeObject, is.string, arguments);
            return { [compName]: _.slice(0, _.get('length')(_.get(compName, result)) / 2)(_.get(compName, result)) };
        }
        is.valid(is.objectWithProps(compProps), is.maybeObject, arguments);
        const memoizeWithResolver = _.memoize.convert({ fixed: false });
        const selectRecordsFunc = memoizeWithResolver(selectRecords, (...args) => JSON.stringify(args));
        return chain(
            () => getUpstreamRecords(comp, comp.name, {}, selectRecordsFunc),
            (result) => getDownstreamRecords(comp, comp.name, result, selectRecordsFunc),
            (result) => removeDuplicates(result, comp.name)
        );
    };

    this.init = async function init(compCollection = []) {
        is.valid(is.maybeArray, arguments);
        compCollection.push(rel);
        const componetSchemas = _.map((comp) => comp().schema(knex, tablePrefix))(compCollection);
        await Promise.all(componetSchemas);
        _.each((comp) => (comps[comp().name] = comp))(compCollection);
    };

    this.fn = fn;

    return this;
};

module.exports = fnComp;
