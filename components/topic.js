module.exports = (comp) => {
    const is = comp.is;
    const name = 'topic';

    async function schema(knex, tablePrefix = '') {
        const tableName = tablePrefix + name;
        if (!(await knex.schema.hasTable(tableName))) {
            return knex.schema.createTable(tableName, function (table) {
                table.increments('id').primary();
                table.text('title').notNullable();
                table.timestamps(false, true);
                table.index('updated_at');
            });
        }
    }

    function data(input) {
        is.valid(
            is.objectWithProps({
                id: is.maybeNumber,
                title: is.maybeString,
                createdAt: is.maybeDate,
                updatedAt: is.maybeDate,
            }),
            arguments
        );
        return {
            id: input?.id,
            title: input?.title,
            created_at: input?.createdAt,
            updated_at: input?.updatedAt,
        };
    }

    return comp.define(name, schema, data);
};
