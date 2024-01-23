const _ = require('lodash/fp');
const is = require('fn-arg-validator');
const fn = require('fn-tester');

const comp = function (knex, tablePrefix = '') {
    is.valid(is.object, is.maybeString, arguments);
    const componentProps = { data: is.func, schema: is.func };

    function extractComponentData(component) {
        is.valid(is.objectWithProps(componentProps), arguments);
        let componentData = component.data();
        let componentName = _.flow(_.keys, _.head)(componentData);
        let componentKeyValues = _.flow(
            _.get(componentName),
            _.pickBy((v) => !_.isUndefined(v))
        )(componentData);
        return [componentName, componentKeyValues];
    }

    async function insertRecord(componentName, componentKeyValues) {
        return await knex(componentName).insert(componentKeyValues).returning('id');
    }

    async function selectRecords(componentName, componentKeyValues) {
        return await knex(componentName).select('*').where(componentKeyValues);
    }

    this.create = async function create(component, rels = []) {
        is.valid(is.objectWithProps(componentProps), is.maybeArray, arguments);
        const [componentName, componentKeyValues] = extractComponentData(component);
        return await fn.run(insertRecord, null, componentName, componentKeyValues);
    };

    this.get = async function get(component, filters) {
        is.valid(is.objectWithProps(componentProps), is.maybeObject, arguments);
        const [componentName, componentKeyValues] = extractComponentData(component);
        const result = fn.run(selectRecords, null, componentName, componentKeyValues);
        return { [componentName]: _.head(result) };
    };

    this.fn = fn;

    return this;
};

module.exports = comp;
