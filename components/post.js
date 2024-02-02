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
                    table.text('postText').notNullable();
                    table.timestamps(false, true, true);
                });
            }
        },
    };

    return function (id, postText) {
        is.valid(is.maybeNumber, is.maybeString, arguments);
        const compObject = Object.create(compSchema);
        compObject.data = () => {
            return {
                [compName]: {
                    id,
                    postText,
                },
            };
        };
        return compObject;
    };
}

module.exports = post;
