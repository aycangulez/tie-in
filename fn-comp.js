const _ = require('lodash/fp');
const chain = require('fn-one');
const rel = require('./components/rel')();
const memoizeWithResolver = _.memoize.convert({ fixed: false });

const fnComp = function (knexConfig, tablePrefix = '', is) {
    if (!is) {
        var is = require('fn-arg-validator');
        is.config.throw = true;
    }
    is.valid(is.object, is.maybeString, is.maybeObject, arguments);

    const knex = require('knex')(knexConfig);
    const comps = {};
    const compProps = { name: is.string, relType: is.maybeString, data: is.func, schema: is.func };
    const getFilterProps = {
        aggregate: is.maybeArray,
        downstreamLimit: is.maybeNumber,
        upstreamLimit: is.maybeNumber,
        filterUpstreamBy: is.maybeArray,
        where: is.maybeFunc,
        orderBy: is.maybeArray,
        offset: is.maybeNumber,
        limit: is.maybeNumber,
    };

    // Removes columns with undefined values
    function compact(compData) {
        is.valid(is.object, arguments);
        return _.pickBy((v) => !_.isUndefined(v))(compData);
    }

    // Returns aliased column names in camelCase for use in select operations
    function getColumnNamesForSelect(comp) {
        is.valid(is.objectWithProps(compProps), arguments);
        const colNames = {};
        _.each((k) => (colNames[_.camelCase(k)] = k))(_.keys(comp.data()));
        return colNames;
    }

    // Converts column names to snake case for use in inserts/updates
    function getColumnNamesForUpdate(comp) {
        is.valid(is.objectWithProps(compProps), arguments);
        const colNames = {};
        _.each((k) => (colNames[_.snakeCase(k)] = comp.data()[k]))(_.keys(compact(comp.data())));
        return colNames;
    }

    // Inserts a component record and returns its id
    async function insertRecord(comp, trx = knex) {
        is.valid(is.objectWithProps(compProps), is.maybeObject, arguments);
        return trx(tablePrefix + comp.name)
            .insert(getColumnNamesForUpdate(comp))
            .returning('id')
            .then(_.flow(_.head, _.get('id')));
    }

    // Deletes component records
    async function deleteRecords(comp, trx = knex) {
        is.valid(is.objectWithProps(compProps), is.maybeObject, arguments);
        return trx(tablePrefix + comp.name)
            .where(getColumnNamesForUpdate(comp))
            .del();
    }

    // Modifies a query according to filter options
    function queryFilterModifier(query, filters) {
        query
            .orderBy(...(_.flow(_.get('orderBy'), _.isArray)(filters) ? filters.orderBy : ['id']))
            .offset(_.get('offset')(filters) || 0);
        const aggregateFuncs = _.get('aggregate')(filters);
        if (aggregateFuncs) {
            query.clear('select');
            query.clear('order');
        }
        _.each((v) => {
            const fn = _.get('fn')(v);
            const availableFns = ['avg', 'avgDistinct', 'count', 'countDistinct', 'min', 'max', 'sum', 'sumDistinct'];
            if (_.indexOf(fn)(availableFns) !== -1) {
                const argVal = _.flow(_.get('args'), _.trim)(v);
                query[fn]({ [fn]: argVal === '*' ? '*' : _.snakeCase(argVal) });
            }
        })(aggregateFuncs);
        query.andWhere(filters.where || (() => {}));
        const limit = _.get('limit')(filters) || 10;
        if (limit !== -1) {
            query.limit(limit);
        }
        return query;
    }

    // Selects component records
    async function selectRecords(comp, filters, trx = knex) {
        is.valid(is.objectWithProps(compProps), is.objectWithProps(getFilterProps), is.maybeObject, arguments);
        return trx(tablePrefix + comp.name)
            .select()
            .columns(getColumnNamesForSelect(comp))
            .where(compact(comp.data()))
            .modify(queryFilterModifier, filters);
    }

    // Selects component records filtered by associated component records (effectively an inner join)
    async function selectRecordsByRel(comp, filters, trx = knex) {
        is.valid(is.objectWithProps(compProps), is.objectWithProps(getFilterProps), is.maybeObject, arguments);
        function generateExistsConditon(filterComp) {
            is.valid(is.objectWithProps(compProps), arguments);
            return trx
                .from(tablePrefix + 'rel')
                .select('rel.target_id')
                .where('rel.source_comp', filterComp.name)
                .andWhere('rel.source_id', _.get('id')(filterComp.data()))
                .andWhere('rel.target_comp', comp.name)
                .andWhereRaw('rel.target_id = ' + comp.name + '.id');
        }
        const relatedComps = _.get('filterUpstreamBy')(filters);
        return trx(tablePrefix + comp.name)
            .select()
            .columns(getColumnNamesForSelect(comp))
            .where(compact(comp.data()))
            .whereExists(
                _.get('length')(relatedComps) > 1
                    ? trx.intersect(_.map(generateExistsConditon)(relatedComps), true)
                    : generateExistsConditon(_.head(relatedComps))
            )
            .modify(queryFilterModifier, filters);
    }

    // Inserts upstream relations for given component records, ignores existing relations
    async function insertUpstreamRels(targetComp, relSources = [], trx = knex) {
        is.valid(is.objectWithProps(compProps), is.maybeArray, is.maybeObject, arguments);
        const targetCompRecs = await selectRecords(targetComp, { limit: -1 }, trx);
        for (const targetCompRec of targetCompRecs) {
            for (const relSource of relSources) {
                let relSourceRecs = await selectRecords(relSource, { limit: -1 }, trx);
                for (const relSourceRec of relSourceRecs) {
                    let relComp = rel({
                        sourceComp: relSource.name,
                        sourceId: relSourceRec.id,
                        targetComp: targetComp.name,
                        targetId: targetCompRec.id,
                        type: relSource.relType,
                    });
                    await selectRecords(relComp, {}, trx).then((result) =>
                        _.head(result) ? false : insertRecord(relComp, trx)
                    );
                }
            }
        }
    }

    // Inserts downstream relations for given component records, ignores existing relations
    async function insertDownstreamRels(sourceComp, relTargets = [], trx = knex) {
        is.valid(is.objectWithProps(compProps), is.maybeArray, is.maybeObject, arguments);
        const sourceCompRecs = await selectRecords(sourceComp, { limit: -1 }, trx);
        for (const sourceCompRec of sourceCompRecs) {
            for (const relTarget of relTargets) {
                let relTargetRecs = await selectRecords(relTarget, { limit: -1 }, trx);
                for (const relTargetRec of relTargetRecs) {
                    let relComp = rel({
                        sourceComp: sourceComp.name,
                        sourceId: sourceCompRec.id,
                        targetComp: relTarget.name,
                        targetId: relTargetRec.id,
                        type: relTarget.relType,
                    });
                    await selectRecords(relComp, {}, trx).then((result) =>
                        _.head(result) ? false : insertRecord(relComp, trx)
                    );
                }
            }
        }
    }

    // Returns related upstream records for given component record(s), but doesn't immediately retrieve related record details
    async function getUpstreamRecords(
        comp,
        result,
        relType,
        level,
        filters,
        selectRecordsFunc,
        selectRecordsByRelFunc,
        saveCallsFunc
    ) {
        is.valid(
            is.objectWithProps(compProps),
            is.object,
            is.maybeString,
            is.number,
            is.objectWithProps(getFilterProps),
            is.func,
            is.func,
            is.func,
            arguments
        );
        let compRecs;
        if (level === 0) {
            compRecs = filters.filterUpstreamBy
                ? await selectRecordsByRelFunc(comp, filters)
                : await selectRecordsFunc(comp, filters);
        } else {
            compRecs = [{ id: _.get('id')(comp.data()), relType, _unresolved: comp.name }];
            saveCallsFunc(comp);
        }
        if (!result[comp.name]) {
            result[comp.name] = [];
        }
        const allRelRecs =
            level !== filters.upstreamLimit
                ? _.groupBy('targetId')(
                      await selectRecordsFunc(rel({ targetComp: comp.name }), {
                          where: (query) => query.whereIn('target_id', _.map((c) => c.id)(compRecs)),
                          limit: -1,
                      })
                  )
                : {};
        for (let i = 0, cLen = compRecs.length; i < cLen; i++) {
            result[comp.name].push({ self: compRecs[i] });
            let relRecs = allRelRecs[compRecs[i].id] || [];
            for (const relRec of relRecs) {
                let sourceComp = comps[relRec.sourceComp]({ id: relRec.sourceId });
                result[comp.name][i] = await getUpstreamRecords(
                    sourceComp,
                    result[comp.name][i],
                    relRec.type,
                    level + 1,
                    filters,
                    selectRecordsFunc,
                    selectRecordsByRelFunc,
                    saveCallsFunc
                );
            }
        }
        return result;
    }

    // Returns related downstream records for given component record(s), but doesn't immediately retrieve related record details
    async function getDownstreamRecords(
        comp,
        result,
        relType,
        level,
        filters,
        selectRecordsFunc,
        selectRecordsByRelFunc,
        saveCallsFunc
    ) {
        is.valid(
            is.objectWithProps(compProps),
            is.object,
            is.maybeString,
            is.number,
            is.objectWithProps(getFilterProps),
            is.func,
            is.func,
            is.func,
            arguments
        );
        let compRecs;
        if (level === 0) {
            compRecs = filters.filterUpstreamBy
                ? await selectRecordsByRelFunc(comp, filters)
                : await selectRecordsFunc(comp, filters);
        } else {
            compRecs = [{ id: _.get('id')(comp.data()), relType, _unresolved: comp.name }];
            saveCallsFunc(comp);
        }
        if (!result[comp.name]) {
            result[comp.name] = [];
        }
        const allRelRecs =
            level !== filters.upstreamLimit
                ? _.groupBy('sourceId')(
                      await selectRecordsFunc(rel({ sourceComp: comp.name }), {
                          where: (query) => query.whereIn('source_id', _.map((c) => c.id)(compRecs)),
                          limit: -1,
                      })
                  )
                : {};
        for (let i = 0, cLen = compRecs.length; i < cLen; i++) {
            result[comp.name].push({ self: compRecs[i] });
            let relRecs = allRelRecs[compRecs[i].id] || [];
            for (const relRec of relRecs) {
                let targetComp = comps[relRec.targetComp]({ id: relRec.targetId });
                result[comp.name][i] = await getDownstreamRecords(
                    targetComp,
                    result[comp.name][i],
                    relRec.type,
                    level + 1,
                    filters,
                    selectRecordsFunc,
                    selectRecordsByRelFunc,
                    saveCallsFunc
                );
            }
        }
        return result;
    }

    // Fills in the details of unresolved related component records
    function resolveRelatedCompRecords(result, relCompRecords) {
        is.valid(is.object, is.array, arguments);
        _.each((k) => {
            if (_.isArray(result[k])) {
                for (let i = 0, len = result[k].length; i < len; i++) {
                    result[k][i] = resolveRelatedCompRecords(result[k][i], relCompRecords);
                }
            } else {
                let unresolved = _.get('_unresolved')(result[k]);
                if (unresolved) {
                    let resolvedRecs = _.flow(_.find({ name: unresolved }), _.get('result'))(relCompRecords);
                    result[k] = { relType: result[k].relType, ..._.find({ id: _.get('id')(result[k]) })(resolvedRecs) };
                }
            }
        })(_.keys(result));
        return result;
    }

    // Creates the relations for given component records
    async function createRels(comp, rels, trx) {
        is.valid(is.objectWithProps(compProps), is.maybeObject, is.maybeObject, arguments);
        async function steps(trx) {
            return await chain(
                () => insertUpstreamRels(comp, _.get('upstream')(rels), trx),
                () => insertDownstreamRels(comp, _.get('downstream')(rels), trx)
            );
        }
        return trx ? await steps(trx) : await knex.transaction(steps);
    }

    // Gets the relations for given component records
    async function getRels(comp, trx) {
        is.valid(is.objectWithProps(compProps), is.maybeObject, arguments);
        async function steps(trx) {
            const rels = { upstream: [], downstream: [] };
            return await chain(
                () => selectRecords(comp, {}, trx),
                async (recs) => {
                    for (const rec of recs) {
                        rels.upstream.push(
                            ...(await selectRecords(rel({ targetComp: comp.name, targetId: rec.id }), {}, trx))
                        );
                        rels.downstream.push(
                            ...(await selectRecords(rel({ sourceComp: comp.name, sourceId: rec.id }), {}, trx))
                        );
                    }
                    return rels;
                }
            );
        }
        return trx ? await steps(trx) : await knex.transaction(steps);
    }

    // Creates a component record and optionally its relations
    async function create(comp, rels, trx) {
        is.valid(is.objectWithProps(compProps), is.maybeObject, is.maybeObject, arguments);
        async function steps(trx) {
            return await chain(
                () => insertRecord(comp, trx),
                (id) => createRels(comps[comp.name]({ id }), rels, trx)
            );
        }
        return trx ? await steps(trx) : await knex.transaction(steps);
    }

    // Updates a single component record by id
    async function updateById(comp, trx = knex) {
        is.valid(is.objectWithProps(compProps), is.maybeObject, arguments);
        return trx(tablePrefix + comp.name)
            .update(getColumnNamesForUpdate(comp))
            .where('id', comp.data().id);
    }

    // Deletes component records and their relations
    async function del(comp, trx) {
        is.valid(is.objectWithProps(compProps), is.maybeObject, arguments);
        async function steps(trx) {
            return await chain(
                () => selectRecords(comp, {}, trx),
                async (recs) => {
                    for (const rec of recs) {
                        await deleteRecords(rel({ targetComp: comp.name, targetId: rec.id }), trx);
                        await deleteRecords(rel({ sourceComp: comp.name, sourceId: rec.id }), trx);
                    }
                },
                () => deleteRecords(comp, trx)
            );
        }
        return trx ? await steps(trx) : await knex.transaction(steps);
    }

    // Returns one or more component records and some or all related records
    async function get(comp, filters = {}) {
        is.valid(is.objectWithProps(compProps), is.objectWithProps(getFilterProps), arguments);
        const compCalls = {};
        // Saves all related component record database calls in a buffer (compCalls)
        function saveCalls(comp) {
            is.valid(is.objectWithProps(compProps), arguments);
            if (!compCalls[comp.name]) {
                compCalls[comp.name] = [_.get('id')(comp.data())];
            } else {
                compCalls[comp.name].push(_.get('id')(comp.data()));
            }
        }
        // Retrieves all related component records in one pass using the call buffer (compCalls)
        async function getRelatedCompRecords() {
            return Promise.all(
                _.map((k) =>
                    selectRecords(comps[k](), {
                        where: (query) => query.whereIn('id', _.uniq(compCalls[k])),
                        limit: -1,
                    }).then((result) => ({ name: k, result }))
                )(_.keys(compCalls))
            );
        }
        // Removes the duplicate records created as a side effect of upstream/downstream record processing
        function removeDuplicates(result, compName) {
            is.valid(is.maybeObject, is.string, arguments);
            const compResult = _.get(compName)(result);
            const halfLength = _.get('length')(compResult) / 2;
            return { [compName]: _.slice(0, halfLength)(compResult) };
        }

        filters.upstreamLimit = _.isUndefined(filters.upstreamLimit) ? 10 : filters.upstreamLimit;
        filters.downstreamLimit = _.isUndefined(filters.downstreamLimit) ? 10 : filters.downstreamLimit;
        if (filters.aggregate) {
            filters.upstreamLimit = 0;
            filters.downstreamLimit = 0;
        }
        const resolverFunc = (comp, ...args) => JSON.stringify([comp.name, comp.data(), args]);
        const selectRecordsM = memoizeWithResolver(selectRecords, resolverFunc);
        const selectRecordsByRelM = memoizeWithResolver(selectRecordsByRel, resolverFunc);
        return chain(
            () => getUpstreamRecords(comp, {}, '', 0, filters, selectRecordsM, selectRecordsByRelM, saveCalls),
            (result) =>
                getDownstreamRecords(comp, result, '', 0, filters, selectRecordsM, selectRecordsByRelM, saveCalls),
            (result) => removeDuplicates(result, comp.name),
            (result) =>
                getRelatedCompRecords().then((relCompRecords) => resolveRelatedCompRecords(result, relCompRecords))
        );
    }

    // Initializes the library by registering passed components and creating the necessary database schemas if necessary
    async function init(compCollection = []) {
        is.valid(is.maybeArray, arguments);
        compCollection.push(rel);
        const componetSchemas = _.map((comp) => comp().schema(knex, tablePrefix))(compCollection);
        await Promise.all(componetSchemas);
        _.each((comp) => (comps[comp().name] = comp))(compCollection);
    }

    return {
        knex,
        is,
        rel,
        createRels,
        getRels,
        create,
        updateById,
        del,
        get,
        init,
    };
};

module.exports = fnComp;
