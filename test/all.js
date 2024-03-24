const knexConfig = {
    client: 'pg',
    connection: process.env.FN_COMP_PG_CONNECTION_STRING,
    debug: false,
};

const comp = require('../fn-comp')(knexConfig, 'comp_');
const knex = comp.knex;
const user = require('../components/user')(comp);
const post = require('../components/post')(comp);
const topic = require('../components/topic')(comp);
const _ = require('lodash/fp');
const chai = require('chai');
chai.use(require('chai-datetime')).should();
chai.use(require('chai-as-promised')).should();
const should = chai.should();

async function clearDB() {
    const promises = [];
    const tables = ['comp_rel', 'comp_user', 'comp_post', 'comp_topic'];
    _.each((v) => promises.push(knex.schema.dropTableIfExists(v)))(tables);
    return Promise.all(promises).then(() => comp.register([user, post, topic]));
}

describe('comp', function () {
    before(async function () {
        await clearDB();
    });

    after(async function () {
        await knex.destroy();
    });

    it('checks invalid component registration', async function () {
        await comp.register([comp.rel]).should.eventually.be.rejectedWith('reserved');
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
        await comp.update(user({ id: 1 }), user({ email: 'asuka@localhost', updatedAt: now }));
        const user1 = await comp.get(user({ id: 1 }));
        user1.should.have.nested
            .include({ 'user[0].self.username': 'Asuka' })
            .and.have.nested.include({ 'user[0].self.email': 'asuka@localhost' });
        user1.user[0].self.updatedAt.should.equalDate(now);
    });

    it('creates post and associates with upstream user', async function () {
        await comp.create(post({ content: 'Post 1' }), { upstream: [user({ id: 1, relType: 'author' })] });
        await comp
            .get(post({ id: 1 }))
            .should.eventually.have.nested.include({ 'post[0].self.content': 'Post 1' })
            .and.have.nested.include({ 'post[0].user[0].self.relType': 'author' })
            .and.have.nested.include({ 'post[0].user[0].self.username': 'Asuka' });
    });

    it('creates topic and associates with upstream user and downstream post', async function () {
        await comp.create(topic({ title: 'Topic 1' }), {
            upstream: [user({ id: 1, relType: 'starter' })],
            downstream: [post({ id: 1, relType: 'child' })],
        });
        await comp
            .get(topic({ id: 1 }))
            .should.eventually.have.nested.include({ 'topic[0].self.title': 'Topic 1' })
            .and.have.nested.include({ 'topic[0].user[0].self.relType': 'starter' })
            .and.have.nested.include({ 'topic[0].user[0].self.username': 'Asuka' })
            .and.have.nested.include({ 'topic[0].post[0].self.relType': 'child' })
            .and.have.nested.include({ 'topic[0].post[0].self.content': 'Post 1' });
    });

    it('adds post by new user to topic and gets posts in descending order', async function () {
        await comp.create(user({ username: 'Katniss', email: 'katniss@localhost' }));
        await comp.create(post({ content: 'Post 2' }), {
            upstream: [user({ id: 2, relType: 'author' }), topic({ id: 1, relType: 'child' })],
        });
        await comp
            .get(post(), { orderBy: [{ column: 'createdAt', order: 'desc' }] })
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
                filterUpstreamBy: [topic({ id: 1 })],
                orderBy: [{ column: 'createdAt', order: 'desc' }],
            })
            .should.eventually.have.nested.include({ 'post[0].self.content': 'Post 2' })
            .and.have.nested.include({ 'post[0].user[0].self.username': 'Katniss' })
            .and.have.nested.include({ 'post[0].topic[0].self.title': 'Topic 1' })
            .and.have.nested.include({ 'post[1].self.content': 'Post 1' })
            .and.have.nested.include({ 'post[1].user[0].self.username': 'Asuka' })
            .and.have.nested.include({ 'post[1].topic[0].self.title': 'Topic 1' })
            .and.does.not.have.nested.include({ 'post[0].topic[0].user[0].self.username': 'Asuka' });
    });
    it('gets posts in topic #1 by user #2 while upstream traversel is limited to 1 level', async function () {
        await comp
            .get(post(), {
                upstreamLimit: 1,
                filterUpstreamBy: [topic({ id: 1 }), user({ id: 2 })],
                orderBy: [{ column: 'createdAt', order: 'desc' }],
            })
            .should.eventually.have.nested.include({ 'post[0].self.content': 'Post 2' })
            .and.have.nested.include({ 'post[0].user[0].self.username': 'Katniss' })
            .and.have.nested.include({ 'post[0].topic[0].self.title': 'Topic 1' })
            .and.does.not.have.nested.include({ 'post[1].self.content': 'Post 1' });
    });
    it('gets posts with ids greater than 2 with upstream and downstream set to 0', async function () {
        await comp
            .get(post(), {
                upstreamLimit: 0,
                downstreamLimit: 0,
                where: (query) => query.where('id', '>', 2),
            })
            .should.eventually.have.nested.include({ 'post[0].self.content': 'Post 3' })
            .and.does.not.have.nested.include({ 'post[0].user[0].self.username': 'Katniss' })
            .and.does.not.have.nested.include({ 'post[0].topic[0].self.title': 'Topic 2' });
    });

    it('Counts posts', async function () {
        await comp
            .get(post(), { aggregate: [{ fn: 'count', args: '*' }] })
            .should.eventually.have.nested.include({ 'post[0].aggregate.count': '3' });
    });

    it('Groups posts by user in descending username order', async function () {
        const filters = {
            aggregate: [{ fn: 'count', args: '*' }],
            group: { by: user(), columns: ['id', 'username'] },
            orderBy: [{ column: 'username', order: 'desc' }],
        };
        await comp
            .get(post(), filters)
            .should.eventually.have.nested.include({ 'post[0].aggregate.count': '2' })
            .and.have.nested.include({ 'post[0].aggregate.username': 'Katniss' })
            .and.have.nested.include({ 'post[1].aggregate.count': '1' })
            .and.have.nested.include({ 'post[1].aggregate.username': 'Asuka' });
    });

    it('Groups posts by user in topic #1 in descending username order', async function () {
        const filters = {
            aggregate: [{ fn: 'count', args: '*' }],
            filterUpstreamBy: [topic({ id: 1 })],
            group: { by: user(), columns: ['id', 'username'] },
            orderBy: [{ column: 'username', order: 'desc' }],
        };
        await comp
            .get(post(), filters)
            .should.eventually.have.nested.include({ 'post[0].aggregate.count': '1' })
            .and.have.nested.include({ 'post[0].aggregate.username': 'Katniss' })
            .and.have.nested.include({ 'post[1].aggregate.count': '1' })
            .and.have.nested.include({ 'post[1].aggregate.username': 'Asuka' });
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
