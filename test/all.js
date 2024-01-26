const knex = require('knex')({
    client: 'pg',
    connection: process.env.FN_COMP_PG_CONNECTION_STRING,
    searchPath: ['knex', 'public'],
    debug: true,
});

const comp = require('../fn-comp')(knex);
const post = require('../components/post')();
const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const should = chai.should();
chai.use(chaiAsPromised).should();

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
