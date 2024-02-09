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
                    table.text('topic_title').notNullable();
                    table.timestamps(false, true);
                    table.index('updated_at');
                });
            }
        },
    };

    return function (id, topicTitle) {
        is.valid(is.maybeNumber, is.maybeString, arguments);
        const compObject = Object.create(compSchema);
        compObject.data = () => {
            return {
                id,
                topic_title: topicTitle,
                created_at: undefined,
                updated_at: undefined,
            };
        };
        return compObject;
    };
}

module.exports = topic;
