const { is } = require('../helper');

function rel(compName = 'rel') {
    const compSchema = {
        async schema(knex, tablePrefix = '') {
            is.valid(is.object, is.maybeString, arguments);
            const tableName = tablePrefix + compName;
            const exists = await knex.schema.hasTable(tableName);
            if (!exists) {
                return knex.schema.createTable(tableName, function (table) {
                    table.increments('id').primary();
                    table.string('sourceComponent').notNullable();
                    table.integer('sourceId').notNullable();
                    table.string('targetComponent').notNullable();
                    table.integer('targetId').notNullable();
                    table.timestamps(false, true, true);
                    table.index(['sourceComponent', 'sourceId']);
                    table.index(['targetComponent', 'targetId']);
                });
            }
        },
    };

    return function (id, sourceComponent, sourceId, targetComponent, targetId) {
        is.valid(is.maybeNumber, is.maybeString, is.maybeNumber, is.maybeString, is.maybeNumber, arguments);
        const compObject = Object.create(compSchema);
        compObject.data = () => {
            return {
                [compName]: {
                    id,
                    sourceComponent,
                    sourceId,
                    targetComponent,
                    targetId,
                },
            };
        };
        return compObject;
    };
}

module.exports = rel;
