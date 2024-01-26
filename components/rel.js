const is = require('fn-arg-validator');

function rel(componentName = 'rel') {
    const compSchema = {
        async schema(knex, tablePrefix = '') {
            is.valid(is.object, is.maybeString, arguments);
            const tableName = tablePrefix + componentName;
            const exists = await knex.schema.hasTable(tableName);
            if (!exists) {
                return await knex.schema.createTable(tableName, function (table) {
                    table.increments('id').primary();
                    table.string('sourceComponent');
                    table.integer('sourceId');
                    table.string('targetComponent');
                    table.integer('targetId');
                    table.timestamps(false, true, true);
                });
            }
        },
    };

    return function (id, sourceComponent, sourceId, targetComponent, targetId) {
        is.valid(is.maybeNumber, is.maybeString, is.maybeNumber, is.maybeString, is.maybeNumber, arguments);
        const compObject = Object.create(compSchema);
        compObject.data = () => {
            return {
                [componentName]: {
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
