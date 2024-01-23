const knex = require('knex')({
    client: 'pg',
    connection: process.env.FN_COMP_PG_CONNECTION_STRING,
    searchPath: ['knex', 'public'],
    debug: true,
});

const comp = require('../fn-comp')(knex);
const is = require('fn-arg-validator');
const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const should = chai.should();
chai.use(chaiAsPromised).should();

function post(id, postText) {
    is.valid(is.maybeNumber, is.maybeString, arguments);
    const componentName = post.name;
    return {
        data: () => {
            return {
                [componentName]: {
                    id,
                    postText,
                },
            };
        },
        schema: async (knex, tablePrefix = '') => {
            const tableName = tablePrefix + componentName;
            const exists = await knex.schema.hasTable(tableName);
            if (!exists) {
                return await knex.schema.createTable(tableName, function (table) {
                    table.increments('id').primary();
                    table.string('postText');
                    table.timestamps(false, true, true);
                });
            }
        },
    };
}

describe('comp.get', function () {
    it('should call fn.selectRecords', async function () {
        comp.fn.test = {
            enabled: true,
            calls: [],
            doubles: [
                function selectRecords() {
                    return Promise.resolve();
                },
            ],
        };

        await comp.fn.run(comp, 'get', post(1));
        comp.fn.test.calls.should.be.an('array').that.deep.includes(['selectRecords', 'post', { id: 1 }]);
    });
});
