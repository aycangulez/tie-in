const _ = require('lodash/fp');
const chain = require('fn-one');
const { is } = require('./helper');
const rel = require('./components/rel')();
const memoizeWithResolver = _.memoize.convert({ fixed: false });

const fnComp = function (knexConfig, tablePrefix = '') {
    const knex = require('knex')(knexConfig);
    is.valid(is.object, is.maybeString, arguments);
    const comps = {};
    const compProps = { name: is.string, data: is.func, schema: is.func };

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
        delete colNames.relType;
        return colNames;
    }

    // Converts column names to snake case for use in inserts/updates
    function getColumnNamesForUpdate(comp) {
        is.valid(is.objectWithProps(compProps), arguments);
        const colNames = {};
        _.each((k) => (colNames[_.snakeCase(k)] = comp.data()[k]))(_.keys(compact(comp.data())));
        delete colNames.relType;
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
        const limit = _.get('limit')(filters) || 10;
        if (limit !== -1) {
            query.limit(limit);
        }
        return query;
    }

    // Selects component records
    async function selectRecords(comp, filters, trx = knex) {
        is.valid(is.objectWithProps(compProps), is.maybeObject, is.maybeObject, arguments);
        const colNames = compact(comp.data());
        delete colNames.relType;
        return trx(tablePrefix + comp.name)
            .select()
            .columns(getColumnNamesForSelect(comp))
            .where(colNames)
            .modify(queryFilterModifier, filters);
    }

    // Selects component records filtered by associated component records (effectively an inner join)
    async function selectRecordsByFilter(comp, filters, trx = knex) {
        is.valid(is.objectWithProps(compProps), is.object, is.maybeObject, arguments);
        return trx(tablePrefix + comp.name)
            .select()
            .columns(getColumnNamesForSelect(comp))
            .whereExists(function () {
                if (filters.comps.length > 1) {
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
                            )(filters.comps);
                            return queries;
                        })(),
                        true
                    );
                } else {
                    this.from(tablePrefix + 'rel')
                        .select('rel.target_id')
                        .where('rel.source_comp', filters.comps[0].name)
                        .andWhere('rel.source_id', _.get('id')(filters.comps[0].data()))
                        .andWhere('rel.target_comp', comp.name)
                        .andWhereRaw('rel.target_id = ' + comp.name + '.id');
                }
            })
            .modify(queryFilterModifier, filters);
    }

    // Selects multiple records using a list of ids
    async function selectRecordsById(comp, ids, trx = knex) {
        is.valid(is.objectWithProps(compProps), is.array, is.maybeObject, arguments);
        return trx(tablePrefix + comp.name)
            .select()
            .columns(getColumnNamesForSelect(comp))
            .whereIn('id', ids);
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
                        type: relSource.data().relType,
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
                        type: relTarget.data().relType,
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
        selectRecordsByFilterFunc,
        saveCallsFunc
    ) {
        is.valid(
            is.objectWithProps(compProps),
            is.object,
            is.maybeString,
            is.number,
            is.object,
            is.func,
            is.func,
            is.func,
            arguments
        );
        let compRecs;
        if (level === 0) {
            compRecs = filters.filterUpstreamBy
                ? await selectRecordsByFilterFunc(comp, filters.filterUpstreamBy)
                : await selectRecordsFunc(comp, filters);
        } else {
            compRecs = [{ id: _.get('id')(comp.data()), relType, _unresolved: comp.name }];
            saveCallsFunc(comp);
        }
        if (!result[comp.name]) {
            result[comp.name] = [];
        }
        for (let i = 0, cLen = compRecs.length; i < cLen; i++) {
            result[comp.name].push({ self: compRecs[i] });
            if (level === filters.upstreamLimit) {
                continue;
            }
            let relComp = rel({ targetComp: comp.name, targetId: _.get('id')(compRecs[i]) });
            let relRecs = await selectRecordsFunc(relComp, { limit: -1 });

            for (let j = 0, rLen = relRecs.length; j < rLen; j++) {
                let relRec = relRecs[j];
                let sourceComp = comps[relRec.sourceComp]({ id: relRec.sourceId });
                result[comp.name][i] = await getUpstreamRecords(
                    sourceComp,
                    result[comp.name][i],
                    relRec.type,
                    level + 1,
                    filters,
                    selectRecordsFunc,
                    selectRecordsByFilterFunc,
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
        selectRecordsByFilterFunc,
        saveCallsFunc
    ) {
        is.valid(
            is.objectWithProps(compProps),
            is.object,
            is.maybeString,
            is.number,
            is.object,
            is.func,
            is.func,
            is.func,
            arguments
        );
        let compRecs;
        if (level === 0) {
            compRecs = filters.filterUpstreamBy
                ? await selectRecordsByFilterFunc(comp, filters.filterUpstreamBy)
                : await selectRecordsFunc(comp, filters);
        } else {
            compRecs = [{ id: _.get('id')(comp.data()), relType, _unresolved: comp.name }];
            saveCallsFunc(comp);
        }
        if (!result[comp.name]) {
            result[comp.name] = [];
        }
        for (let i = 0, cLen = compRecs.length; i < cLen; i++) {
            result[comp.name].push({ self: compRecs[i] });
            if (level === filters.downstreamLimit) {
                continue;
            }
            let relComp = rel({ sourceComp: comp.name, sourceId: _.get('id')(compRecs[i]) });
            let relRecs = await selectRecordsFunc(relComp, { limit: -1 });

            for (let j = 0, rLen = relRecs.length; j < rLen; j++) {
                let relRec = relRecs[j];
                let targetComp = comps[relRec.targetComp]({ id: relRec.targetId });
                result[comp.name][i] = await getDownstreamRecords(
                    targetComp,
                    result[comp.name][i],
                    relRec.type,
                    level + 1,
                    filters,
                    selectRecordsFunc,
                    selectRecordsByFilterFunc,
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
    this.createRels = async function createRels(comp, rels, trx) {
        is.valid(is.objectWithProps(compProps), is.maybeObject, is.maybeObject, arguments);
        async function steps(trx) {
            return await chain(
                () => insertUpstreamRels(comp, _.get('upstream')(rels), trx),
                () => insertDownstreamRels(comp, _.get('downstream')(rels), trx)
            );
        }
        return trx ? await steps(trx) : await knex.transaction(steps);
    };

    // Gets the relations for given component records
    this.getRels = async function getRels(comp, trx) {
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
    };

    // Creates a component record and optionally its relations
    this.create = async function create(comp, rels, trx) {
        is.valid(is.objectWithProps(compProps), is.maybeObject, is.maybeObject, arguments);
        async function steps(trx) {
            return await chain(
                () => insertRecord(comp, trx),
                (id) => this.createRels(comps[comp.name]({ id }), rels, trx)
            );
        }
        return trx ? await steps(trx) : await knex.transaction(steps);
    };

    // Updates a single component record by id
    this.updateById = async function update(comp, trx = knex) {
        is.valid(is.objectWithProps(compProps), is.maybeObject, arguments);
        return trx(tablePrefix + comp.name)
            .update(getColumnNamesForUpdate(comp))
            .where('id', comp.data().id);
    };

    // Deletes component records and their relations
    this.del = async function del(comp, trx) {
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
    };

    // Returns one or more component records and some or all related records
    this.get = async function get(comp, filters = {}) {
        is.valid(is.objectWithProps(compProps), is.maybeObject, arguments);
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
                    selectRecordsById(comps[k](), _.uniq(compCalls[k])).then((result) => ({ name: k, result }))
                )(_.keys(compCalls))
            );
        }
        // Removes the duplicate records created as a side effect of upstream/downstream record processing
        function removeDuplicates(result, compName) {
            is.valid(is.maybeObject, is.string, arguments);
            return { [compName]: _.slice(0, _.get('length')(_.get(compName, result)) / 2)(_.get(compName, result)) };
        }

        filters.upstreamLimit = _.isUndefined(filters.upstreamLimit) ? 10 : filters.upstreamLimit;
        filters.downstreamLimit = _.isUndefined(filters.downstreamLimit) ? 10 : filters.downstreamLimit;
        if (filters.aggregate) {
            filters.upstreamLimit = 0;
            filters.downstreamLimit = 0;
        }
        const resolverFunc = (comp, ...args) => JSON.stringify([comp.name, comp.data(), args]);
        const selectRecordsM = memoizeWithResolver(selectRecords, resolverFunc);
        const selectRecordsByFilterM = memoizeWithResolver(selectRecordsByFilter, resolverFunc);
        return chain(
            () => getUpstreamRecords(comp, {}, '', 0, filters, selectRecordsM, selectRecordsByFilterM, saveCalls),
            (result) => getDownstreamRecords(comp, result, '', 0, filters, selectRecordsM, selectRecordsM, saveCalls),
            (result) => removeDuplicates(result, comp.name),
            (result) =>
                getRelatedCompRecords().then((relCompRecords) => resolveRelatedCompRecords(result, relCompRecords))
        );
    };

    // Initializes the library by registering passed components and creating the necessary database schemas if necessary
    this.init = async function init(compCollection = []) {
        is.valid(is.maybeArray, arguments);
        compCollection.push(rel);
        const componetSchemas = _.map((comp) => comp().schema(knex, tablePrefix))(compCollection);
        await Promise.all(componetSchemas);
        _.each((comp) => (comps[comp().name] = comp))(compCollection);
    };

    this.knex = knex;
    this.is = is;
    this.rel = rel;

    return this;
};

module.exports = fnComp;
