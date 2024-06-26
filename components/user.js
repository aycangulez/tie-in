module.exports = (tie) => {
    const name = 'user';
    const is = tie.is;

    async function schema(knex, tablePrefix) {
        const tableName = tablePrefix + name;
        if (!(await knex.schema.hasTable(tableName))) {
            return knex.schema.createTable(tableName, function (table) {
                table.increments('id').primary();
                table.string('username').notNullable();
                table.string('email').notNullable();
                table.string('country', 2);
                table.timestamps(false, true);
                table.unique('username');
                table.unique('email');
            });
        }
    }

    function data(input) {
        is.valid(
            is.objectWithProps({
                id: is.maybeNumber,
                username: is.maybeString,
                email: is.maybeString,
                country: is.maybeString,
                createdAt: is.maybeDate,
                updatedAt: is.maybeDate,
            }),
            arguments
        );
        return {
            id: input?.id,
            username: input?.username,
            email: input?.email,
            country: input?.country,
            created_at: input?.createdAt,
            updated_at: input?.updatedAt,
        };
    }

    return tie.define(name, schema, data);
};
