const _ = require('lodash/fp');
const chain = require('fn-one');
const fn = require('fn-tester');
const { is } = require('./helper');
const rel = require('./components/rel')();

const fnComp = function (knex, tablePrefix = '') {
    is.valid(is.object, is.maybeString, arguments);
    const compProps = { data: is.func, schema: is.func };

    function extractCompData(comp) {
        is.valid(is.objectWithProps(compProps), arguments);
        let compData = comp.data();
        let compName = _.flow(_.keys, _.head)(compData);
        let compKeyVals = _.flow(
            _.get(compName),
            _.pickBy((v) => !_.isUndefined(v))
        )(compData);
        return [compName, compKeyVals];
    }

    function insertRecord([compName, compKeyVals], trx = knex) {
        is.valid(is.maybeArray, is.maybeObject, arguments);
        return trx(tablePrefix + compName)
            .insert(compKeyVals)
            .returning('id')
            .then(_.flow(_.head, _.get('id')));
    }

    function selectRecords([compName, compKeyVals], trx = knex) {
        is.valid(is.maybeArray, is.maybeObject, arguments);
        return trx(tablePrefix + compName)
            .select('*')
            .where(compKeyVals)
            .then(_.head);
    }

    async function checkRelSources(relSources, trx = knex) {
        is.valid(is.maybeArray, is.maybeObject, arguments);
        const sourceRecords = _.map((v) => selectRecords(extractCompData(v), trx))(relSources);
        const sourceData = await Promise.all(sourceRecords);
        const numSourcesReturned = _.flow(_.compact, _.get('length'))(sourceData);
        if (numSourcesReturned < _.get('length')(relSources)) {
            throw new Error('Missing relation sources.');
        }
    }

    async function insertRels(relSources, targetComponent, targetId, trx = knex) {
        is.valid(is.maybeArray, is.maybeString, is.maybeNumber, is.maybeObject, arguments);
        let promises = [];
        _.each((relSource) => {
            let [relSourceName, relSourceKeyValues] = extractCompData(relSource);
            let relRecord = {
                sourceComponent: relSourceName,
                sourceId: _.get('id')(relSourceKeyValues),
                targetComponent,
                targetId,
            };
            promises.push(() =>
                selectRecords(['rel', relRecord], trx).then((result) =>
                    result ? false : fn.run(insertRecord, null, ['rel', relRecord], trx)
                )
            );
        })(relSources);
        for (let p in promises) {
            await promises[p]();
        }
        return targetId;
    }

    this.create = async function create(comp, relSources = []) {
        is.valid(is.objectWithProps(compProps), is.maybeArray, arguments);
        const compData = extractCompData(comp);
        return await knex.transaction(
            async (trx) =>
                await chain(
                    () => fn.run(checkRelSources, null, relSources, trx),
                    () => fn.run(insertRecord, null, compData, trx),
                    (id) => fn.run(insertRels, null, relSources, compData[0], id, trx)
                )
        );
    };

    this.get = async function get(comp, filters) {
        is.valid(is.objectWithProps(compProps), is.maybeObject, arguments);
        const compData = extractCompData(comp);
        const result = fn.run(selectRecords, null, compData);
        return { [compData[0]]: _.head(result) };
    };

    this.init = async function init(comps = []) {
        is.valid(is.maybeArray, arguments);
        const componetSchemas = _.map((comp) => comp.schema(knex, tablePrefix))(comps);
        await Promise.all(componetSchemas);
        await rel().schema(knex, tablePrefix);
    };

    this.fn = fn;

    return this;
};

module.exports = fnComp;
