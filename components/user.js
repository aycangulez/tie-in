const { is } = require('../helper');

function user(compName = 'user') {
    const compSchema = {
        name: compName,
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
            is.objectWithProps({ id: is.maybeNumber, username: is.maybeString, email: is.maybeString }),
            arguments
        );
        const compObject = Object.create(compSchema);
        compObject.data = () => ({
            id: input?.id,
            username: input?.username,
            email: input?.email,
            created_at: undefined,
            updated_at: undefined,
        });
        return compObject;
    };
}

module.exports = user;
