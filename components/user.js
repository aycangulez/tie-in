const is = require('fn-arg-validator');

function user(compName = 'user') {
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
                    table.string('username').notNullable();
                    table.string('email').notNullable();
                    table.timestamps(false, true);
                    table.unique('email');
                });
            }
        },
    };

    return function (input) {
        is.valid(
            is.objectWithProps({
                id: is.maybeNumber,
                username: is.maybeString,
                email: is.maybeString,
                createdAt: is.maybeDate,
                updatedAt: is.maybeDate,
                relType: is.maybeString,
            }),
            arguments
        );
        const compObject = Object.create(compSchema);
        Object.defineProperty(compObject, 'relType', { value: input?.relType });
        compObject.data = () => ({
            id: input?.id,
            username: input?.username,
            email: input?.email,
            created_at: input?.createdAt,
            updated_at: input?.updatedAt,
        });
        return compObject;
    };
}

module.exports = user;
