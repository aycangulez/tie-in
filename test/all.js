const knexConfig = {
    client: 'pg',
    connection: process.env.FN_COMP_PG_CONNECTION_STRING,
    searchPath: ['knex', 'public'],
    debug: false,
};

const comp = require('../fn-comp')(knexConfig);
const knex = comp.knex;
const user = require('../components/user')();
const post = require('../components/post')();
const topic = require('../components/topic')();
const _ = require('lodash/fp');
const chai = require('chai');
chai.use(require('chai-datetime')).should();
chai.use(require('chai-as-promised')).should();
const should = chai.should();

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

    it('creates user inside an external transaction', async function () {
        await knex.transaction(
            async (trx) => await comp.create(user({ username: 'Asuka', email: 'asuka@elsewhere' }), {}, trx)
        );
        await comp
            .get(user({ id: 1 }))
            .should.eventually.have.nested.include({ 'user[0].self.username': 'Asuka' })
            .and.have.nested.include({ 'user[0].self.email': 'asuka@elsewhere' });
    });

    it('updates user', async function () {
        const now = new Date();
        await comp.update(user({ id: 1, email: 'asuka@localhost' }), now);
        const user1 = await comp.get(user({ id: 1 }));
        user1.should.have.nested
            .include({ 'user[0].self.username': 'Asuka' })
            .and.have.nested.include({ 'user[0].self.email': 'asuka@localhost' });
        user1.user[0].self.updatedAt.should.equalDate(now);
    });

    it('creates post and associates with upstream user', async function () {
        await comp.create(post({ content: 'Post 1' }), { upstream: [user({ id: 1 })] });
        await comp
            .get(post({ id: 1 }))
            .should.eventually.have.nested.include({ 'post[0].self.content': 'Post 1' })
            .and.have.nested.include({ 'post[0].user[0].self.username': 'Asuka' });
    });

    it('creats topic and associates with upstream user and downstream post', async function () {
        await comp.create(topic({ title: 'Topic 1' }), { upstream: [user({ id: 1 })], downstream: [post({ id: 1 })] });
        await comp
            .get(topic({ id: 1 }))
            .should.eventually.have.nested.include({ 'topic[0].self.title': 'Topic 1' })
            .and.have.nested.include({ 'topic[0].user[0].self.username': 'Asuka' })
            .and.have.nested.include({ 'topic[0].post[0].self.content': 'Post 1' });
    });

    it('adds post by new user to topic and gets posts in descending order', async function () {
        await comp.create(user({ username: 'Katniss', email: 'katniss@localhost' }));
        await comp.create(post({ content: 'Post 2' }), { upstream: [user({ id: 2 }), topic({ id: 1 })] });
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
        await comp.create(topic({ title: 'Topic 2' }));
        await comp.create(post({ content: 'Post 3' }), { upstream: [user({ id: 2 }), topic({ id: 2 })] });
        await comp
            .get(post(), {
                upstreamLimit: 1,
                filterUpstreamBy: { comps: [topic({ id: 1 })], orderBy: ['createdAt', 'desc'] },
            })
            .should.eventually.have.nested.include({ 'post[0].self.content': 'Post 2' })
            .and.have.nested.include({ 'post[0].user[0].self.username': 'Katniss' })
            .and.have.nested.include({ 'post[0].topic[0].self.title': 'Topic 1' })
            .and.have.nested.include({ 'post[1].self.content': 'Post 1' })
            .and.have.nested.include({ 'post[1].user[0].self.username': 'Asuka' })
            .and.have.nested.include({ 'post[1].topic[0].self.title': 'Topic 1' })
            .and.does.not.have.nested.include({ 'post[0].topic[0].user[0].self.username': 'Asuka' });
    });

    it('Deletes a post and its relations', async function () {
        const postId = _.get('post[0].self.id')(await comp.get(post({ content: 'Post 3' }), { upstreamLimit: 0 }));
        const postRels = await comp.getRels(post({ id: postId }));
        postRels.upstream.should.have.lengthOf(2);
        await comp.del(post({ id: postId }));
        const postAfterDelete = await comp.get(post({ id: postId }));
        const postRelsAfterDelete = await comp.getRels(post({ id: postId }));
        postAfterDelete.post.should.have.lengthOf(0);
        postRelsAfterDelete.upstream.should.have.lengthOf(0);
    });
});
