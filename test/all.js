const knex = require('knex')({
    client: 'pg',
    connection: process.env.FN_COMP_PG_CONNECTION_STRING,
    searchPath: ['knex', 'public'],
    debug: false,
});

const comp = require('../fn-comp')(knex);
const user = require('../components/user')();
const post = require('../components/post')();
const topic = require('../components/topic')();
const _ = require('lodash/fp');
const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const should = chai.should();
chai.use(chaiAsPromised).should();

async function clearDB() {
    const promises = [];
    const tables = ['rel', 'user', 'post', 'topic'];
    _.each((v) => promises.push(knex.schema.dropTableIfExists(v)))(tables);
    return Promise.all(promises).then(() => comp.init([user, post, topic]));
}

describe('comp', function () {
    before(async function () {
        await clearDB();
    });

    after(async function () {
        await knex.destroy();
    });

    it('creates and gets user', async function () {
        await comp.create(user(undefined, 'Asuka', 'asuka@localhost'));
        await comp
            .get(user(1))
            .should.eventually.have.nested.include({ 'user[0].self.username': 'Asuka' })
            .and.have.nested.include({ 'user[0].self.email': 'asuka@localhost' });
    });

    it('creates post and associates with upstream user', async function () {
        await comp.create(post(undefined, 'Post 1'), [user(1)]);
        await comp
            .get(post(1))
            .should.eventually.have.nested.include({ 'post[0].self.content': 'Post 1' })
            .and.have.nested.include({ 'post[0].user[0].self.username': 'Asuka' });
    });

    it('creats topic and associates with upstream user and downstream post', async function () {
        await comp.create(topic(undefined, 'Topic 1'), [user(1)], [post(1)]);
        await comp
            .get(topic(1))
            .should.eventually.have.nested.include({ 'topic[0].self.title': 'Topic 1' })
            .and.have.nested.include({ 'topic[0].user[0].self.username': 'Asuka' })
            .and.have.nested.include({ 'topic[0].post[0].self.content': 'Post 1' });
    });

    it('adds post by new user to topic and gets posts in descending order', async function () {
        await comp.create(user(undefined, 'Katniss', 'katniss@localhost'));
        await comp.create(post(undefined, 'Post 2'), [user(2), topic(1)]);
        await comp
            .get(post(), { orderBy: ['createdAt', 'desc'] })
            .should.eventually.have.nested.include({ 'post[0].self.content': 'Post 2' })
            .and.have.nested.include({ 'post[0].user[0].self.username': 'Katniss' })
            .and.have.nested.include({ 'post[0].topic[0].self.title': 'Topic 1' })
            .and.have.nested.include({ 'post[0].topic[0].user[0].self.username': 'Asuka' })
            .and.have.nested.include({ 'post[1].self.content': 'Post 1' })
            .and.have.nested.include({ 'post[1].user[0].self.username': 'Asuka' })
            .and.have.nested.include({ 'post[1].topic[0].self.title': 'Topic 1' })
            .and.have.nested.include({ 'post[1].topic[0].user[0].self.username': 'Asuka' });
    });

    it('gets posts in topic #1 in descending order while upstream traversel is limited to 1 level', async function () {
        await comp.create(topic(undefined, 'Topic 2'));
        await comp.create(post(undefined, 'Post 3'), [user(2), topic(2)]);
        await comp
            .get(post(), {
                upstreamLimit: 1,
                filterUpstreamBy: { comp: [topic(1)], orderBy: ['createdAt', 'desc'] },
            })
            .should.eventually.have.nested.include({ 'post[0].self.content': 'Post 2' })
            .and.have.nested.include({ 'post[0].user[0].self.username': 'Katniss' })
            .and.have.nested.include({ 'post[0].topic[0].self.title': 'Topic 1' })
            .and.have.nested.include({ 'post[1].self.content': 'Post 1' })
            .and.have.nested.include({ 'post[1].user[0].self.username': 'Asuka' })
            .and.have.nested.include({ 'post[1].topic[0].self.title': 'Topic 1' })
            .and.does.not.have.nested.include({ 'post[0].topic[0].user[0].self.username': 'Asuka' });
    });
});
