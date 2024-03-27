module.exports = (tie) => {
    const name = 'post';
    const is = tie.is;

    async function schema(knex, tablePrefix) {
        const tableName = tablePrefix + name;
        if (!(await knex.schema.hasTable(tableName))) {
            return knex.schema.createTable(tableName, function (table) {
                table.increments('id').primary();
                table.text('content').notNullable();
                table.timestamps(false, true);
            });
        }
    }

    function data(input) {
        is.valid(
            is.objectWithProps({
                id: is.maybeNumber,
                content: is.maybeString,
                createdAt: is.maybeDate,
                updatedAt: is.maybeDate,
            }),
            arguments
        );
        return {
            id: input?.id,
            content: input?.content,
            created_at: input?.createdAt,
            updated_at: input?.updatedAt,
        };
    }

    return tie.define(name, schema, data);
};
