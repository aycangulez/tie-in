const is = require('fn-arg-validator');

function rel(compName = 'rel') {
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
                    table.string('source_comp').notNullable();
                    table.integer('source_id').notNullable();
                    table.string('target_comp').notNullable();
                    table.integer('target_id').notNullable();
                    table.string('type');
                    table.timestamps(false, true);
                    table.unique(['source_comp', 'source_id', 'target_comp', 'target_id', 'type']);
                    table.index(['target_comp', 'target_id']);
                });
            }
        },
    };

    return function (input) {
        is.valid(
            is.objectWithProps({
                id: is.maybeNumber,
                sourceComp: is.maybeString,
                sourceId: is.maybeNumber,
                targetComp: is.maybeString,
                targetId: is.maybeNumber,
                type: is.maybeString,
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
            source_comp: input?.sourceComp,
            source_id: input?.sourceId,
            target_comp: input?.targetComp,
            target_id: input?.targetId,
            type: input?.type,
            created_at: input?.createdAt,
            updated_at: input?.updatedAt,
        });
        return compObject;
    };
}

module.exports = rel;
