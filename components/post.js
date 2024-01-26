const is = require('fn-arg-validator');

function post(componentName = 'post') {
    const compSchema = {
        async schema(knex, tablePrefix = '') {
            is.valid(is.object, is.maybeString, arguments);
            const tableName = tablePrefix + componentName;
            const exists = await knex.schema.hasTable(tableName);
            if (!exists) {
                return await knex.schema.createTable(tableName, function (table) {
                    table.increments('id').primary();
                    table.text('postText');
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
                [componentName]: {
                    id,
                    postText,
                },
            };
        };
        return compObject;
    };
}

module.exports = post;
