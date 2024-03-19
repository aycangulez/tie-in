const is = require('fn-arg-validator');

function post(compName = 'post') {
    const compSchema = {
        get name() {
            return compName;
        },
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
        is.valid(
            is.objectWithProps({
                id: is.maybeNumber,
                content: is.maybeString,
                createdAt: is.maybeDate,
                updatedAt: is.maybeDate,
                relType: is.maybeString,
            }),
            arguments
        );
        const compObject = Object.create(compSchema);
        compObject.data = () => ({
            id: input?.id,
            content: input?.content,
            created_at: input?.createdAt,
            updated_at: input?.updatedAt,
            relType: input?.relType,
        });
        return compObject;
    };
}

module.exports = post;
