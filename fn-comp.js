const _ = require('lodash/fp');
const chain = require('fn-one');
const { is } = require('./helper');
const rel = require('./components/rel')();
const memoizeWithResolver = _.memoize.convert({ fixed: false });

const fnComp = function (knexConfig, tablePrefix = '') {
    const knex = require('knex')(knexConfig);
    is.valid(is.object, is.maybeString, arguments);
    var comps = {};
    const compProps = { name: is.string, data: is.func, schema: is.func };

    // Removes columns with undefined values
    function compact(compData) {
        is.valid(is.object, arguments);
        return _.pickBy((v) => !_.isUndefined(v))(compData);
    }

    // Returns aliased column names in camelCase for use in select operations
    function getColumnNamesForSelect(compData) {
        is.valid(is.object, arguments);
        let colNames = {};
        _.each((k) => (colNames[_.camelCase(k)] = k))(_.keys(compData));
        return colNames;
    }

    // Converts column names to snake case for use in inserts/updates
    function getColumnNamesForUpdate(compData) {
        is.valid(is.object, arguments);
        let colNames = {};
        _.each((k) => (colNames[_.snakeCase(k)] = compData[k]))(_.keys(compData));
        return colNames;
    }

    // Inserts a component record and returns its id
    async function insertRecord(comp, trx = knex) {
        is.valid(is.objectWithProps(compProps), is.maybeObject, arguments);
        return trx(tablePrefix + comp.name)
            .insert(getColumnNamesForUpdate(compact(comp.data())))
            .returning('id')
            .then(_.flow(_.head, _.get('id')));
    }

    // Selects component records
    async function selectRecords(comp, filters, trx = knex) {
        is.valid(is.objectWithProps(compProps), is.maybeObject, is.maybeObject, arguments);
        const limit = _.get('limit')(filters) || 10;
        return trx(tablePrefix + comp.name)
            .select()
            .columns(getColumnNamesForSelect(comp.data()))
            .where(compact(comp.data()))
            .orderBy(...(_.flow(_.get('orderBy'), _.isArray)(filters) ? filters.orderBy : ['id']))
            .offset(_.get('offset')(filters) || 0)
            .limit(limit === -1 ? 1000000000 : limit);
    }

    // Selects component records filtered by associated component records (effectively an inner join)
    async function selectRecordsByFilter(comp, filters, trx = knex) {
        is.valid(is.objectWithProps(compProps), is.object, is.maybeObject, arguments);
        const limit = _.get('limit')(filters) || 10;
        return trx(tablePrefix + comp.name)
            .select()
            .columns(getColumnNamesForSelect(comp.data()))
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
            .orderBy(...(_.flow(_.get('orderBy'), _.isArray)(filters) ? filters.orderBy : ['id']))
            .offset(_.get('offset')(filters) || 0)
            .limit(limit === -1 ? 1000000000 : limit);
    }

    // Selects multiple records using a list of ids
    async function selectRecordsById(comp, ids, trx = knex) {
        is.valid(is.objectWithProps(compProps), is.array, is.maybeObject, arguments);
        return trx(tablePrefix + comp.name)
            .select()
            .columns(getColumnNamesForSelect(comp.data()))
            .whereIn('id', ids);
    }

    // Checks if all given relations exist in the database
    async function checkRelSources(relSources, trx = knex) {
        is.valid(is.maybeArray, is.maybeObject, arguments);
        const sourcePromises = _.map((v) => selectRecords(v, {}, trx))(relSources);
        const sourceRecs = await Promise.all(sourcePromises);
        const numSourcesReturned = _.flow(_.compact, _.get('length'))(sourceRecs);
        if (numSourcesReturned < _.get('length')(relSources)) {
            throw new Error('Missing relation sources.');
        }
    }

    // Inserts given upstream relations for a component record
    async function insertUpstreamRels(relSources, targetComp, targetId, trx = knex) {
        is.valid(is.maybeArray, is.maybeString, is.maybeNumber, is.maybeObject, arguments);
        let promises = [];
        _.each((relSource) => {
            let relComp = rel({
                sourceComp: relSource.name,
                sourceId: _.get('id')(relSource.data()),
                targetComp,
                targetId,
            });
            promises.push(() =>
                selectRecords(relComp, {}, trx).then((result) => (_.head(result) ? false : insertRecord(relComp, trx)))
            );
        })(relSources);
        for (let p in promises) {
            await promises[p]();
        }
        return targetId;
    }

    // Inserts given downstream relations for a component record
    async function insertDownstreamRels(relTargets, sourceComp, sourceId, trx = knex) {
        is.valid(is.maybeArray, is.maybeString, is.maybeNumber, is.maybeObject, arguments);
        let promises = [];
        _.each((relTarget) => {
            let relComp = rel({
                sourceComp,
                sourceId,
                targetComp: relTarget.name,
                targetId: _.get('id')(relTarget.data()),
            });
            promises.push(() =>
                selectRecords(relComp, {}, trx).then((result) => (_.head(result) ? false : insertRecord(relComp, trx)))
            );
        })(relTargets);
        for (let p in promises) {
            // Need to do inserts one by one in a transaction
            await promises[p]();
        }
        return sourceId;
    }

    // Returns related upstream records for given component record(s), but doesn't immediately retrieve related record details
    async function getUpstreamRecords(
        comp,
        result = {},
        level = 0,
        filters,
        selectRecordsFunc,
        selectRecordsByFilterFunc,
        saveCallsFunc
    ) {
        is.valid(is.objectWithProps(compProps), is.object, is.number, is.object, is.func, is.func, is.func, arguments);
        let compRecs;
        if (level === 0) {
            compRecs = filters.filterUpstreamBy
                ? await selectRecordsByFilterFunc(comp, filters.filterUpstreamBy)
                : await selectRecordsFunc(comp, filters);
        } else {
            compRecs = [{ id: _.get('id')(comp.data()), _unresolved: comp.name }];
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
        result = {},
        level = 0,
        filters,
        selectRecordsFunc,
        selectRecordsByFilterFunc,
        saveCallsFunc
    ) {
        is.valid(is.objectWithProps(compProps), is.object, is.number, is.object, is.func, is.func, is.func, arguments);
        let compRecs;
        if (level === 0) {
            compRecs = filters.filterUpstreamBy
                ? await selectRecordsByFilterFunc(comp, filters.filterUpstreamBy)
                : await selectRecordsFunc(comp, filters);
        } else {
            compRecs = [{ id: _.get('id')(comp.data()), _unresolved: comp.name }];
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
                    result[k] = _.find({ id: _.get('id')(result[k]) })(resolvedRecs);
                }
            }
        })(_.keys(result));
        return result;
    }

    // Creates a component record and optionally its relations
    this.create = async function create(comp, upstreamRelSources = [], downstreamRelTargets = [], trx) {
        is.valid(is.objectWithProps(compProps), is.maybeArray, is.maybeArray, is.maybeObject, arguments);
        async function steps(trx) {
            return await chain(
                () => checkRelSources(_.concat(upstreamRelSources, downstreamRelTargets), trx),
                () => insertRecord(comp, trx),
                (id) => insertUpstreamRels(upstreamRelSources, comp.name, id, trx),
                (id) => insertDownstreamRels(downstreamRelTargets, comp.name, id, trx)
            );
        }
        return trx ? await steps(trx) : await knex.transaction(steps);
    };

    // Updates a component record, optionally accepts a value for the updatedAt field
    this.update = async function update(comp, now = new Date(), trx = knex) {
        is.valid(is.objectWithProps(compProps), is.maybeDate, is.maybeObject, arguments);
        const fields = compact(comp.data());
        if (!fields.updatedAt) {
            fields.updatedAt = now;
        }
        return trx(tablePrefix + comp.name)
            .update(getColumnNamesForUpdate(fields))
            .where('id', fields.id);
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
            return await Promise.all(
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

        filters.upstreamLimit = filters.upstreamLimit || 10;
        filters.downstreamLimit = filters.downstreamLimit || 10;
        const resolverFunc = (comp, ...args) => JSON.stringify([comp.name, comp.data(), args]);
        const selectRecordsFunc = memoizeWithResolver(selectRecords, resolverFunc);
        const selectRecordsByFilterFunc = memoizeWithResolver(selectRecordsByFilter, resolverFunc);
        return chain(
            () => getUpstreamRecords(comp, {}, 0, filters, selectRecordsFunc, selectRecordsByFilterFunc, saveCalls),
            (result) =>
                getDownstreamRecords(comp, result, 0, filters, selectRecordsFunc, selectRecordsByFilterFunc, saveCalls),
            (result) => removeDuplicates(result, comp.name),
            async (result) => {
                relCompRecords = await getRelatedCompRecords();
                return resolveRelatedCompRecords(result, relCompRecords);
            }
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

    return this;
};

module.exports = fnComp;
