const _ = require('lodash/fp');
const chain = require('fn-one');
const { is } = require('./helper');
const rel = require('./components/rel')();
const memoizeWithResolver = _.memoize.convert({ fixed: false });

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

    async function insertRecord(comp, trx = knex) {
        is.valid(is.objectWithProps(compProps), is.maybeObject, arguments);
        return trx(tablePrefix + comp.name)
            .insert(compact(comp.data()))
            .returning('id')
            .then(_.flow(_.head, _.get('id')));
    }

    async function selectRecords(comp, trx = knex, orderBy = ['id'], offset = 0, limit = 10) {
        is.valid(
            is.objectWithProps(compProps),
            is.maybeObject,
            is.maybeArray,
            is.maybeNumber,
            is.maybeNumber,
            arguments
        );
        return trx(tablePrefix + comp.name)
            .select()
            .columns(getColumnNames(comp.data()))
            .where(compact(comp.data()))
            .orderBy(...orderBy)
            .offset(offset)
            .limit(limit === -1 ? 1000000000 : limit);
    }

    async function selectRecordsByFilter(comp, filterComps, orderBy = ['id'], trx = knex, offset = 0, limit = 10) {
        is.valid(
            is.objectWithProps(compProps),
            is.array,
            is.maybeArray,
            is.maybeObject,
            is.maybeNumber,
            is.maybeNumber,
            arguments
        );
        return trx(tablePrefix + comp.name)
            .select()
            .columns(getColumnNames(comp.data()))
            .whereExists(function () {
                if (filterComps.length > 1) {
                    this.intersect(
                        (function () {
                            let queries = [];
                            _.each((filterComp) =>
                                queries.push(
                                    trx
                                        .from(tablePrefix + 'rel')
                                        .select('rel.target_id')
                                        .where('rel.source_comp', filterComp.name)
                                        .andWhere('rel.source_id', _.get('id')(filterComp.data()))
                                        .andWhere('rel.target_comp', comp.name)
                                        .andWhereRaw('rel.target_id = ' + comp.name + '.id')
                                )
                            )(filterComps);
                            return queries;
                        })(),
                        true
                    );
                } else {
                    this.from(tablePrefix + 'rel')
                        .select('rel.target_id')
                        .where('rel.source_comp', filterComps[0].name)
                        .andWhere('rel.source_id', _.get('id')(filterComps[0].data()))
                        .andWhere('rel.target_comp', comp.name)
                        .andWhereRaw('rel.target_id = ' + comp.name + '.id');
                }
            })
            .orderBy(...orderBy)
            .offset(offset)
            .limit(limit);
    }

    async function checkRelSources(relSources, trx = knex) {
        is.valid(is.maybeArray, is.maybeObject, arguments);
        const sourcePromises = _.map((v) => selectRecords(v, trx))(relSources);
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
                selectRecords(relComp, trx).then((result) => (_.head(result) ? false : insertRecord(relComp, trx)))
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
                selectRecords(relComp, trx).then((result) => (_.head(result) ? false : insertRecord(relComp, trx)))
            );
        })(relTargets);
        for (let p in promises) {
            await promises[p]();
        }
        return sourceId;
    }

    async function getUpstreamRecords(
        comp,
        result = {},
        level = 0,
        filters,
        selectRecordsFunc,
        selectRecordsByFilterFunc
    ) {
        is.valid(is.objectWithProps(compProps), is.object, is.number, is.object, is.func, is.func, arguments);
        const compRecs =
            level === 0 && filters.filterUpstreamBy
                ? await selectRecordsByFilterFunc(
                      comp,
                      filters.filterUpstreamBy.comp,
                      filters.filterUpstreamBy.orderBy,
                      knex,
                      filters.filterUpstreamBy.offset,
                      filters.filterUpstreamBy.limit
                  )
                : await selectRecordsFunc(comp, knex, filters.orderBy, filters.offset, filters.limit);
        if (!result[comp.name]) {
            result[comp.name] = [];
        }
        for (let i = 0, cLen = compRecs.length; i < cLen; i++) {
            result[comp.name].push({ self: compRecs[i] });
            if (level === filters.upstreamLimit) {
                continue;
            }
            let relComp = rel(undefined, undefined, undefined, comp.name, compRecs[i].id);
            let relRecs = await selectRecordsFunc(relComp, knex, filters.orderBy, 0, -1);

            for (let j = 0, rLen = relRecs.length; j < rLen; j++) {
                let relRec = relRecs[j];
                let sourceComp = comps[relRec.sourceComp](relRec.sourceId);
                result[comp.name][i] = await getUpstreamRecords(
                    sourceComp,
                    result[comp.name][i],
                    level + 1,
                    filters,
                    selectRecordsFunc,
                    selectRecordsByFilterFunc
                );
            }
        }
        return result;
    }

    async function getDownstreamRecords(
        comp,
        result = {},
        level = 0,
        filters,
        selectRecordsFunc,
        selectRecordsByFilterFunc
    ) {
        is.valid(is.objectWithProps(compProps), is.object, is.number, is.object, is.func, is.func, arguments);
        const compRecs =
            level === 0 && filters.filterUpstreamBy
                ? await selectRecordsByFilterFunc(
                      comp,
                      filters.filterUpstreamBy.comp,
                      filters.filterUpstreamBy.orderBy,
                      knex,
                      filters.filterUpstreamBy.offset,
                      filters.filterUpstreamBy.limit
                  )
                : await selectRecordsFunc(comp, knex, filters.offset, filters.limit);
        if (!result[comp.name]) {
            result[comp.name] = [];
        }
        for (let i = 0, cLen = compRecs.length; i < cLen; i++) {
            result[comp.name].push({ self: compRecs[i] });
            if (level === filters.downstreamLimit) {
                continue;
            }
            let relComp = rel(undefined, comp.name, compRecs[i].id);
            let relRecs = await selectRecordsFunc(relComp, knex, filters.orderBy, 0, -1);

            for (let j = 0, rLen = relRecs.length; j < rLen; j++) {
                let relRec = relRecs[j];
                let targetComp = comps[relRec.targetComp](relRec.targetId);
                result[comp.name][i] = await getDownstreamRecords(
                    targetComp,
                    result[comp.name][i],
                    level + 1,
                    filters,
                    selectRecordsFunc,
                    selectRecordsByFilterFunc
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
                    () => checkRelSources(_.concat(upstreamRelSources, downstreamRelTargets), trx),
                    () => insertRecord(comp, trx),
                    (id) => insertUpstreamRels(upstreamRelSources, comp.name, id, trx),
                    (id) => insertDownstreamRels(downstreamRelTargets, comp.name, id, trx)
                )
        );
    };

    this.get = async function get(comp, filters = {}) {
        function removeDuplicates(result, compName) {
            is.valid(is.maybeObject, is.string, arguments);
            return { [compName]: _.slice(0, _.get('length')(_.get(compName, result)) / 2)(_.get(compName, result)) };
        }
        is.valid(is.objectWithProps(compProps), is.maybeObject, arguments);
        filters.upstreamLimit = filters.upstreamLimit || 10;
        filters.downstreamLimit = filters.downstreamLimit || 10;
        const resolverFunc = (comp, ...args) => JSON.stringify([comp.name, comp.data(), args]);
        const selectRecordsFunc = memoizeWithResolver(selectRecords, resolverFunc);
        const selectRecordsByFilterFunc = memoizeWithResolver(selectRecordsByFilter, resolverFunc);
        return chain(
            () => getUpstreamRecords(comp, {}, 0, filters, selectRecordsFunc, selectRecordsByFilterFunc),
            (result) => getDownstreamRecords(comp, result, 0, filters, selectRecordsFunc, selectRecordsByFilterFunc),
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

    return this;
};

module.exports = fnComp;
