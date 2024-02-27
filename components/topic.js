const _ = require('lodash/fp');
const { is } = require('../helper');

function topic(compName = 'topic') {
    const compSchema = {
        name: compName,
        async schema(knex, tablePrefix = '') {
            is.valid(is.object, is.maybeString, arguments);
            const tableName = tablePrefix + compName;
            const exists = await knex.schema.hasTable(tableName);
            if (!exists) {
                return knex.schema.createTable(tableName, function (table) {
                    table.increments('id').primary();
                    table.text('title').notNullable();
                    table.timestamps(false, true);
                    table.index('updated_at');
                });
            }
        },
    };

    return function (input) {
        is.valid(is.objectWithProps({ id: is.maybeNumber, title: is.maybeString }), arguments);
        const compObject = Object.create(compSchema);
        compObject.data = () => ({
            id: _.get('id')(input),
            title: _.get('title')(input),
            created_at: undefined,
            updated_at: undefined,
        });
        return compObject;
    };
}

module.exports = topic;
