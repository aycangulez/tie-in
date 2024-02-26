const { is } = require('../helper');

function rel(compName = 'rel') {
    const compSchema = {
        name: compName,
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
                    table.timestamps(false, true);
                    table.unique(['source_comp', 'source_id', 'target_comp', 'target_id']);
                    table.index(['target_comp', 'target_id']);
                });
            }
        },
    };

    return function (id, sourceComp, sourceId, targetComp, targetId) {
        is.valid(is.maybeNumber, is.maybeString, is.maybeNumber, is.maybeString, is.maybeNumber, arguments);
        const compObject = Object.create(compSchema);
        compObject.data = () => ({
            id,
            source_comp: sourceComp,
            source_id: sourceId,
            target_comp: targetComp,
            target_id: targetId,
            created_at: undefined,
            updated_at: undefined,
        });
        return compObject;
    };
}

module.exports = rel;
