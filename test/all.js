const knexConfig = {
    client: 'pg',
    connection: process.env.TIE_PG_CONNECTION_STRING,
    debug: false,
};

const tie = require('../fn-comp')(knexConfig, 'tie_');
const knex = tie.knex;
const user = require('../components/user')(tie);
const post = require('../components/post')(tie);
const topic = require('../components/topic')(tie);
const _ = require('lodash/fp');
const chai = require('chai');
chai.use(require('chai-datetime')).should();
chai.use(require('chai-as-promised')).should();
const should = chai.should();

async function clearDB() {
    const promises = [];
    const tables = ['tie_rel', 'tie_user', 'tie_post', 'tie_topic'];
    _.each((v) => promises.push(knex.schema.dropTableIfExists(v)))(tables);
    return Promise.all(promises).then(() => tie.register([user, post, topic]));
}

describe('tie-in', function () {
    before(async function () {
        await clearDB();
    });

    after(async function () {
        await knex.destroy();
    });

    it('checks invalid component registration', async function () {
        await tie.register([tie.rel]).should.eventually.be.rejectedWith('reserved');
    });

    it('creates user inside an external transaction', async function () {
        const postId = await knex.transaction(
            async (trx) =>
                await tie.create(user({ username: 'Asuka', email: 'asuka@elsewhere', country: 'JP' }), {}, trx)
        );
        await tie
            .get(user({ id: postId }))
            .should.eventually.have.nested.include({ 'user[0].self.username': 'Asuka' })
            .and.have.nested.include({ 'user[0].self.email': 'asuka@elsewhere' });
    });

    it('updates user', async function () {
        const now = new Date();
        await tie.update(user({ id: 1 }), {}, user({ email: 'asuka@localhost', updatedAt: now }));
        const user1 = await tie.get(user({ id: 1 }));
        user1.should.have.nested
            .include({ 'user[0].self.username': 'Asuka' })
            .and.have.nested.include({ 'user[0].self.email': 'asuka@localhost' });
        user1.user[0].self.updatedAt.should.equalDate(now);
    });

    it('creates post and associates with upstream user', async function () {
        await tie.create(post({ content: 'Post 1' }), { upstream: [user({ id: 1, relType: 'author' })] });
        await tie
            .get(post({ id: 1 }))
            .should.eventually.have.nested.include({ 'post[0].self.content': 'Post 1' })
            .and.have.nested.include({ 'post[0].user[0].self.relType': 'author' })
            .and.have.nested.include({ 'post[0].user[0].self.username': 'Asuka' });
    });

    it('creates topic and associates with upstream user and downstream post', async function () {
        await tie.create(topic({ title: 'Topic 1' }), {
            upstream: [user({ id: 1, relType: 'starter' })],
            downstream: [post({ id: 1, relType: 'child' })],
        });
        await tie
            .get(topic({ id: 1 }))
            .should.eventually.have.nested.include({ 'topic[0].self.title': 'Topic 1' })
            .and.have.nested.include({ 'topic[0].user[0].self.relType': 'starter' })
            .and.have.nested.include({ 'topic[0].user[0].self.username': 'Asuka' })
            .and.have.nested.include({ 'topic[0].post[0].self.relType': 'child' })
            .and.have.nested.include({ 'topic[0].post[0].self.content': 'Post 1' });
    });

    it('adds post by new user to topic and gets posts in descending order', async function () {
        await tie.create(user({ username: 'Katniss', email: 'katniss@localhost' }));
        await tie.create(post({ content: 'Post 2' }), {
            upstream: [user({ id: 2, relType: 'author' }), topic({ id: 1, relType: 'child' })],
        });
        await tie
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
        await tie.create(topic({ title: 'Topic 2' }));
        await tie.create(post({ content: 'Post 3' }), { upstream: [user({ id: 2 }), topic({ id: 2 })] });
        await tie
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
        await tie
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
    it('counts posts in topic #1 that have authors', async function () {
        await tie.get(post(), { filterUpstreamBy: [topic()] }).should.eventually.be.rejectedWith('required');
        await tie
            .get(post(), {
                aggregate: [{ fn: 'count', args: '*' }],
                filterUpstreamBy: [topic({ id: 1 }), user({ relType: 'author' })],
            })
            .should.eventually.have.nested.include({ 'post[0].aggregate.count': '2' });
        await tie
            .get(post(), {
                aggregate: [{ fn: 'count', args: '*' }],
                filterUpstreamBy: [topic({ id: 1 }), user({ relType: '<invalid>' })],
            })
            .should.eventually.have.nested.include({ 'post[0].aggregate.count': '0' });
        await tie
            .get(post(), {
                aggregate: [{ fn: 'count', args: '*' }],
                filterUpstreamBy: [topic({ id: 1 }), user({ id: 2, relType: 'author' })],
            })
            .should.eventually.have.nested.include({ 'post[0].aggregate.count': '1' });
        await tie
            .get(post(), {
                aggregate: [{ fn: 'count', args: '*' }],
                filterUpstreamBy: [topic({ id: 1 }), user({ id: 2, relType: '<invalid>' })],
            })
            .should.eventually.have.nested.include({ 'post[0].aggregate.count': '0' });
    });

    it('gets posts with ids greater than 2 with upstream and downstream set to 0', async function () {
        await tie
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
        await tie
            .get(post(), { aggregate: [{ fn: 'count', args: '*' }] })
            .should.eventually.have.nested.include({ 'post[0].aggregate.count': '3' });
    });

    it('Groups posts by user in descending username order', async function () {
        const filters = {
            aggregate: [{ fn: 'count', args: '*' }],
            group: { by: user(), columns: ['id', 'username'] },
            orderBy: [{ column: 'username', order: 'desc' }],
        };
        await tie
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
        await tie
            .get(post(), filters)
            .should.eventually.have.nested.include({ 'post[0].aggregate.count': '1' })
            .and.have.nested.include({ 'post[0].aggregate.username': 'Katniss' })
            .and.have.nested.include({ 'post[1].aggregate.count': '1' })
            .and.have.nested.include({ 'post[1].aggregate.username': 'Asuka' });
    });

    it('Deletes a post and its relations', async function () {
        const postId = _.get('post[0].self.id')(await tie.get(post({ content: 'Post 3' }), { upstreamLimit: 0 }));
        const postRels = await tie.getRels(post({ id: postId }));
        postRels.upstream.should.have.lengthOf(2);
        await tie.del(post({ id: postId }));
        const postAfterDelete = await tie.get(post({ id: postId }));
        const postRelsAfterDelete = await tie.getRels(post({ id: postId }));
        postAfterDelete.post.should.have.lengthOf(0);
        postRelsAfterDelete.upstream.should.have.lengthOf(0);
    });
});
