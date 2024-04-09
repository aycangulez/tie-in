const _ = require('lodash/fp');
const chain = require('fn-one');
const memoizeWithResolver = _.memoize.convert({ fixed: false });

const fnComp = function (knexConfig, tablePrefix = '', is) {
    if (!is) {
        var is = require('fn-arg-validator');
        is.config.throw = true;
    }
    is.valid(is.object, is.maybeString, is.maybeObject, arguments);

    var rel;
    const knex = require('knex')(knexConfig);
    const comps = {};
    const compProps = { name: is.string, relType: is.maybeString, data: is.func, schema: is.func };
    const getFilterProps = {
        downstreamLimit: is.maybeNumber,
        upstreamLimit: is.maybeNumber,
        filterUpstreamBy: is.maybeArray,
        where: is.maybeFunc,
        aggregate: is.maybeArray,
        group: is.maybeObject,
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

    // Updates a component record matching given id
    async function updateRecord(id, comp, trx = knex) {
        is.valid(is.number, is.objectWithProps(compProps), is.maybeObject, arguments);
        return trx(tablePrefix + comp.name)
            .update(getColumnNamesForUpdate(comp))
            .where({ id });
    }

    // Deletes component records
    async function deleteRecords(comp, trx = knex) {
        is.valid(is.objectWithProps(compProps), is.maybeObject, arguments);
        return trx(tablePrefix + comp.name)
            .where(getColumnNamesForUpdate(comp))
            .del();
    }

    // Selects component records
    async function selectRecords(comp, filters, trx = knex) {
        is.valid(is.objectWithProps(compProps), is.objectWithProps(getFilterProps), is.maybeObject, arguments);
        // Generates one or more exists conditions to filter results (effectively an inner join)
        function generateExistsConditon(filterComp) {
            is.valid(is.objectWithProps(compProps), arguments);
            if (!_.get('id')(filterComp.data()) && !filterComp.relType) {
                throw new Error("Either 'id' or 'relType' is required in 'filterUpstreamBy'");
            }
            const relTable = tablePrefix + 'rel';
            const query = trx(relTable)
                .select(relTable + '.target_id')
                .where(relTable + '.source_comp', filterComp.name);
            if (_.get('id')(filterComp.data())) {
                query.andWhere(relTable + '.source_id', _.get('id')(filterComp.data()));
            }
            query
                .andWhere(relTable + '.target_comp', comp.name)
                .andWhereRaw(relTable + '.target_id = ' + tablePrefix + comp.name + '.id');
            if (filterComp.relType) {
                query.andWhere(relTable + '.type', filterComp.relType);
            }
            return query;
        }
        // Converts given query to an aggregate query
        function handleAggregates(query) {
            const aggregateFuncs = _.get('aggregate')(filters);
            const availableFuncs = ['avg', 'avgDistinct', 'count', 'countDistinct', 'min', 'max', 'sum', 'sumDistinct'];
            if (aggregateFuncs && !filters.group) {
                query.clear('select');
            }
            _.each((v) => {
                const fn = _.get('fn')(v);
                if (_.indexOf(fn)(availableFuncs) !== -1) {
                    const argVal = _.flow(_.get('args'), _.trim)(v);
                    query[fn]({ [fn]: argVal === '*' ? '*' : _.snakeCase(argVal) });
                }
            })(aggregateFuncs);
            return query;
        }
        // Creates a group by query with given query as its subquery
        function handleGroupBy(query) {
            const group = _.get('group')(filters);
            if (!group) {
                return handleAggregates(query);
            }
            const groupTable = tablePrefix + group.by.name;
            const relTable = tablePrefix + 'rel';
            const groupByColumns = _.map((c) => groupTable + '.' + c)(group.columns);
            query.clear('select').select(tablePrefix + comp.name + '.id'); // Turn to subquery
            return handleAggregates(
                trx(relTable)
                    .select(groupByColumns)
                    .leftJoin(groupTable, relTable + '.source_id', groupTable + '.id')
                    .where(relTable + '.source_comp', 'user')
                    .andWhere(relTable + '.target_comp', comp.name)
                    .whereIn(relTable + '.target_id', query)
                    .groupBy(groupByColumns)
            );
        }
        // Adds general filter options to given query
        function addGeneralFilters(query, filters = {}) {
            if (filters.orderBy) {
                query.orderBy(filters.orderBy);
            }
            query.offset(_.get('offset')(filters) || 0);
            query.andWhere(filters.where || (() => {}));
            const limit = _.get('limit')(filters) || 10;
            if (limit !== -1) {
                query.limit(limit);
            }
            return query;
        }
        const query = trx(tablePrefix + comp.name)
            .select()
            .columns(getColumnNamesForSelect(comp))
            .where(compact(comp.data()));
        const relatedComps = _.get('filterUpstreamBy')(filters);
        if (relatedComps) {
            query.whereExists(
                _.get('length')(relatedComps) > 1
                    ? trx.intersect(_.map(generateExistsConditon)(relatedComps), true)
                    : generateExistsConditon(_.head(relatedComps))
            );
        }
        return handleGroupBy(query).modify(addGeneralFilters, filters);
    }

    // Inserts upstream relationships for given component records, ignores existing relationships
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

    // Inserts downstream relationships for given component records, ignores existing relationships
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
    async function getUpstreamRecords(comp, result, relType, level, filters, selectRecordsFunc, saveCallsFunc) {
        is.valid(
            is.objectWithProps(compProps),
            is.object,
            is.maybeString,
            is.number,
            is.objectWithProps(getFilterProps),
            is.func,
            is.func,
            arguments
        );
        let compRecs;
        if (level === 0) {
            compRecs = await selectRecordsFunc(comp, filters);
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
            result[comp.name].push({ [filters.aggregate ? 'aggregate' : 'self']: compRecs[i] });
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
                    saveCallsFunc
                );
            }
        }
        return result;
    }

    // Returns related downstream records for given component record(s), but doesn't immediately retrieve related record details
    async function getDownstreamRecords(comp, result, relType, level, filters, selectRecordsFunc, saveCallsFunc) {
        is.valid(
            is.objectWithProps(compProps),
            is.object,
            is.maybeString,
            is.number,
            is.objectWithProps(getFilterProps),
            is.func,
            is.func,
            arguments
        );
        let compRecs;
        if (level === 0) {
            compRecs = await selectRecordsFunc(comp, filters);
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
            result[comp.name].push({ [filters.aggregate ? 'aggregate' : 'self']: compRecs[i] });
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

    // Creates the relationships for given component records
    async function createRels(comp, rels, trx) {
        is.valid(is.objectWithProps(compProps), is.maybeObject, is.maybeObject, arguments);
        async function steps(trx) {
            return chain(
                () => insertUpstreamRels(comp, _.get('upstream')(rels), trx),
                () => insertDownstreamRels(comp, _.get('downstream')(rels), trx)
            );
        }
        return trx ? steps(trx) : knex.transaction(steps);
    }

    // Gets the relationships for given component records
    async function getRels(comp, filters = {}, trx) {
        is.valid(is.objectWithProps(compProps), is.maybeObject, arguments);
        async function steps(trx) {
            const rels = { upstream: [], downstream: [] };
            return chain(
                () => getRecords(comp, filters, trx),
                async (recs) => {
                    for (const rec of recs) {
                        rels.upstream.push(
                            ...(await getRecords(rel({ targetComp: comp.name, targetId: rec.id }), {}, trx))
                        );
                        rels.downstream.push(
                            ...(await getRecords(rel({ sourceComp: comp.name, sourceId: rec.id }), {}, trx))
                        );
                    }
                    return rels;
                }
            );
        }
        return trx ? steps(trx) : knex.transaction(steps);
    }

    // Returns a custom component object
    function define(compName, schemaFunc, dataFunc) {
        is.valid(is.string, is.func, is.func, arguments);
        const compSchema = {
            get name() {
                return compName;
            },
            schema: schemaFunc,
        };
        return function (input) {
            is.valid(is.objectWithProps({ relType: is.maybeString }), arguments);
            const compObject = Object.create(compSchema);
            Object.defineProperty(compObject, 'relType', { value: input?.relType });
            compObject.data = () => dataFunc(input);
            return compObject;
        };
    }

    // Creates a component record and optionally its related records
    async function create(comp, rels, trx) {
        is.valid(is.objectWithProps(compProps), is.maybeObject, is.maybeObject, arguments);
        async function steps(trx) {
            return chain(
                () => insertRecord(comp, trx),
                (id) => createRels(comps[comp.name]({ id }), rels, trx)
            );
        }
        return trx ? steps(trx) : knex.transaction(steps);
    }

    // Gets records using relevant filters
    function getRecords(comp, filters = {}, trx = knex) {
        is.valid(is.objectWithProps(compProps), is.objectWithProps(getFilterProps), is.maybeObject, arguments);
        return selectRecords(
            comp,
            { ...filters, aggregate: undefined, group: undefined, limit: filters.limit || -1 },
            trx
        );
    }

    // Updates source component records with target component's data
    async function update(targetComp, targetFilters = {}, sourceComp, trx) {
        is.valid(
            is.objectWithProps(compProps),
            is.objectWithProps(getFilterProps),
            is.objectWithProps(compProps),
            is.maybeObject,
            arguments
        );
        async function steps(trx) {
            return chain(
                () => getRecords(targetComp, targetFilters, trx),
                async (recs) => {
                    for (const rec of recs) {
                        await updateRecord(rec.id, sourceComp, trx);
                    }
                }
            );
        }
        return trx ? steps(trx) : knex.transaction(steps);
    }

    // Deletes component records and their relationships
    async function del(comp, filters = {}, trx) {
        is.valid(is.objectWithProps(compProps), is.objectWithProps(getFilterProps), is.maybeObject, arguments);
        async function steps(trx) {
            return chain(
                () => getRecords(comp, filters, trx),
                async (recs) => {
                    for (const rec of recs) {
                        await deleteRecords(rel({ targetComp: comp.name, targetId: rec.id }), trx);
                        await deleteRecords(rel({ sourceComp: comp.name, sourceId: rec.id }), trx);
                        await deleteRecords(comps[comp.name]({ id: rec.id }), trx);
                    }
                }
            );
        }
        return trx ? steps(trx) : knex.transaction(steps);
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
        return chain(
            () => getUpstreamRecords(comp, {}, '', 0, filters, selectRecordsM, saveCalls),
            (result) => getDownstreamRecords(comp, result, '', 0, filters, selectRecordsM, saveCalls),
            (result) => removeDuplicates(result, comp.name),
            (result) =>
                getRelatedCompRecords().then((relCompRecords) => resolveRelatedCompRecords(result, relCompRecords))
        );
    }

    // Initializes the library by registering passed components and creating the necessary database schemas if necessary
    async function register(compCollection = []) {
        is.valid(is.maybeArray, arguments);
        if (_.find((c) => c().name === 'rel')(compCollection)) {
            throw new Error("'rel' is reserved component name.");
        }
        if (!rel) {
            rel = require('./components/rel')(this);
            compCollection.push(rel);
        }
        await Promise.all(_.map((c) => c().schema(knex, tablePrefix))(compCollection));
        _.each((c) => (comps[c().name] = c))(compCollection);
    }

    return {
        knex,
        is,
        get rel() {
            return rel;
        },
        createRels,
        getRels,
        define,
        create,
        update,
        del,
        get,
        register,
    };
};

module.exports = fnComp;
