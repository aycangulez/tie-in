const _ = require('lodash/fp');
const chain = require('fn-one');
const fn = require('fn-tester');
const { is } = require('./helper');
const rel = require('./components/rel')();

const fnComp = function (knex, tablePrefix = '') {
    is.valid(is.object, is.maybeString, arguments);
    var comps = {};
    const compProps = { name: is.string, data: is.func, schema: is.func };

    function compact(comp) {
        is.valid(is.objectWithProps(compProps), arguments);
        return _.flow(
            _.get(comp.name),
            _.pickBy((v) => !_.isUndefined(v))
        )(comp.data());
    }

    function insertRecord(compName, compData, trx = knex) {
        is.valid(is.string, is.object, is.maybeObject, arguments);
        return trx(tablePrefix + compName)
            .insert(compData)
            .returning('id')
            .then(_.flow(_.head, _.get('id')));
    }

    function selectRecords(compName, compData, trx = knex) {
        is.valid(is.string, is.object, is.maybeObject, arguments);
        return trx(tablePrefix + compName)
            .select('*')
            .where(compData)
            .orderBy('id');
    }

    async function checkRelSources(relSources, trx = knex) {
        is.valid(is.maybeArray, is.maybeObject, arguments);
        const sourcePromises = _.map((v) => fn.run(selectRecords, null, v.name, compact(v), trx))(relSources);
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
            let relSourceData = compact(relSource);
            let relData = compact(rel(undefined, relSource.name, _.get('id')(relSourceData), targetComp, targetId));
            promises.push(() =>
                fn
                    .run(selectRecords, null, 'rel', relData, trx)
                    .then((result) => (_.head(result) ? false : fn.run(insertRecord, null, 'rel', relData, trx)))
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
            let relTargetData = compact(relTarget);
            let relData = compact(rel(undefined, sourceComp, sourceId, relTarget.name, _.get('id')(relTargetData)));
            promises.push(() =>
                fn
                    .run(selectRecords, null, 'rel', relData, trx)
                    .then((result) => (_.head(result) ? false : fn.run(insertRecord, null, 'rel', relData, trx)))
            );
        })(relTargets);
        for (let p in promises) {
            await promises[p]();
        }
        return sourceId;
    }

    async function getUpstreamRecords(comp, originCompName = '', result = {}) {
        is.valid(is.objectWithProps(compProps), is.maybeString, is.maybeObject, arguments);
        if (!originCompName) {
            originCompName = comp.name;
        }

        const compRecs = await fn.run(selectRecords, null, comp.name, compact(comp));
        result[comp.name] = [];
        for (let i = 0, cLen = compRecs.length; i < cLen; i++) {
            result[comp.name][i] = { self: compRecs[i] };

            let relData = compact(rel(undefined, undefined, undefined, comp.name, compRecs[i].id));
            let relRecs = await fn.run(selectRecords, null, 'rel', relData);

            for (let j = 0, rLen = relRecs.length; j < rLen; j++) {
                let relRec = relRecs[j];
                if (relRec.sourceComp === originCompName) {
                    break;
                }

                let sourceComp = comps[relRec.sourceComp](relRec.sourceId);
                result[comp.name][i] = await getUpstreamRecords(sourceComp, originCompName, result[comp.name][i]);
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
                    () => fn.run(insertRecord, null, comp.name, compact(comp), trx),
                    (id) => fn.run(insertUpstreamRels, null, upstreamRelSources, comp.name, id, trx),
                    (id) => fn.run(insertDownstreamRels, null, downstreamRelTargets, comp.name, id, trx)
                )
        );
    };

    this.get = async function get(comp, filters = {}) {
        is.valid(is.objectWithProps(compProps), is.maybeObject, arguments);
        return await getUpstreamRecords(comp);
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
