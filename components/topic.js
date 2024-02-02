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
                    table.text('topicTitle').notNullable();
                    table.timestamps(false, true, true);
                    table.index('updatedAt');
                });
            }
        },
    };

    return function (id, topicTitle) {
        is.valid(is.maybeNumber, is.maybeString, arguments);
        const compObject = Object.create(compSchema);
        compObject.data = () => {
            return {
                [compName]: {
                    id,
                    topicTitle,
                },
            };
        };
        return compObject;
    };
}

module.exports = topic;
