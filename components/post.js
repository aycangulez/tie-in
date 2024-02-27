const _ = require('lodash/fp');
const { is } = require('../helper');

function post(compName = 'post') {
    const compSchema = {
        name: compName,
        async schema(knex, tablePrefix = '') {
            is.valid(is.object, is.maybeString, arguments);
            const tableName = tablePrefix + compName;
            const exists = await knex.schema.hasTable(tableName);
            if (!exists) {
                return knex.schema.createTable(tableName, function (table) {
                    table.increments('id').primary();
                    table.text('content').notNullable();
                    table.timestamps(false, true);
                });
            }
        },
    };

    return function (input) {
        is.valid(is.objectWithProps({ id: is.maybeNumber, content: is.maybeString }), arguments);
        const compObject = Object.create(compSchema);
        compObject.data = () => ({
            id: _.get('id')(input),
            content: _.get('content')(input),
            created_at: undefined,
            updated_at: undefined,
        });
        return compObject;
    };
}

module.exports = post;
