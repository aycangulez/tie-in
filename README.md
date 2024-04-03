# Tie-in

Tie-in is a relational data component library that lets you store and query records that can be related to any other record.

## Installation

```bash
npm install --save tie-in
```

Depending on the database(s) you intend to use, you may also need to install one or more of the following database drivers: pg, pg-native, sqlite3, better-sqlite3, mysql, mysql2, oracledb, tedious (mssql). For example:

```bash
npm install --save pg
```

## Usage

First, let's explore a simple example by modeling a basic forum.

By using data components (more on how to define them later), we create a user, a post, and a topic in the relational database of our choice (in this case PostgreSQL):

```js
const dbConfig = {
    client: 'pg',
    connection: 'postgresql://localhost/me'
};

// Load Tie-in and data component definitions
const tie = require('tie-in')(dbConfig);
const user = require('./components/user')(tie);
const post = require('./components/post')(tie);
const topic = require('./components/topic')(tie);

async function firstSteps() {
    // Register the components we will use
    await tie.register([user, post, topic]);

    // Create a user named Asuka
    const userId = await tie.create(user({ username: 'Asuka', email: 'asuka@localhost', country: 'JP' }));

    // Create a post and make its author Asuka
    const postId = await tie.create(post({ content: 'Hi!' }), {
        upstream: [user({ id: userId, relType: 'author' })],
    });

    // Create a topic and make the topic starter Asuka, also make the post a child of this topic
    const topicId = await tie.create(topic({ title: 'First Topic' }), {
        upstream: [user({ id: userId, relType: 'starter' })],
        downstream: [post({ id: postId, relType: 'child' })],
    });

    // Retrieve topic and related records
    const topicRecs = await tie.get(topic({ id: topicId }));
    console.log(JSON.stringify(topicRecs, null, 2));
}

firstSteps();
```

Once the individual records are in place, we retrieve the newly created topic with **tie.get**,  which retrieves all related records grouped together.

```json
{
  "topic": [
    {
      "self": {
        "id": 1,
        "title": "First Topic",
        "createdAt": "2024-03-28T12:27:51.542Z",
        "updatedAt": "2024-03-28T12:27:51.542Z"
      },
      "user": [
        {
          "self": {
            "relType": "starter",
            "id": 1,
            "username": "Asuka",
            "email": "asuka@localhost",
            "country": "JP",
            "createdAt": "2024-03-28T12:27:51.531Z",
            "updatedAt": "2024-03-28T12:27:51.531Z"
          }
        }
      ],
      "post": [
        {
          "self": {
            "relType": "child",
            "id": 1,
            "content": "Hi!",
            "createdAt": "2024-03-28T12:27:51.538Z",
            "updatedAt": "2024-03-28T12:27:51.538Z"
          }
        }
      ]
    }
  ]
}
```

### Highly Granular Relationships

The relationships in a database are usually defined between columns across tables. In Tie-in, however, relationships can be defined between individual records. Relationships can also have types, so you can have multiple relationships between two records.

The ability to associate a record with any other record in any table opens up new possibilities that are hard to accomplish with conventional column-based relationships. In addition, since relationships are dynamic, no schema changes are necessary to define new relationships.

### Defining Components

To define a component, you call **tie.define** with the following arguments.

* **name:** Name of the component
* **schema:** A function that defines the database table schema. Tie-in uses [knex](https://knexjs.org) under the hood. Table field names must be in snake_case for maximum compatibility across different database systems. Tie-in does the snake-case to camelCase conversions and vice versa automatically. The schema function is called when you register components with **tie.register**, and *knex* and *tablePrefix* are passed as arguments to it.
* **data:** A function that accepts an object with field names in camelCase, maps those fields to the database table fields created with schema, and returns the resulting object.

In its simplest form, a component definition should look like the example below. The only requirement is that there must be a field named *id* that uniquely identifies each record.

```js
module.exports = (tie) => {
    const name = 'user';

    async function schema(knex, tablePrefix) {
        const tableName = tablePrefix + name;
        if (!(await knex.schema.hasTable(tableName))) {
            return knex.schema.createTable(tableName, function (table) {
                table.increments('id').primary();
                table.string('username').notNullable();
                table.string('email').notNullable();
                table.string('country', 2);
                table.timestamps(false, true);
                table.unique('username');
                table.unique('email');
            });
        }
    }

    function data(input) {
        return {
            id: input?.id,
            username: input?.username,
            email: input?.email,
            country: input?.country,
            created_at: input?.createdAt,
            updated_at: input?.updatedAt,
        };
    }

    return tie.define(name, schema, data);
};
```

You might probably want to validate the input passed to the **data** function. Tie-in uses [fn-arg-validator](https://www.npmjs.com/package/fn-arg-validator) for internal data validation, and exposes it through **tie.is**, but you can of course use any other library you would like. Here's another component with data validation in place:

```js
module.exports = (tie) => {
    const name = 'post';
    const is = tie.is;

    async function schema(knex, tablePrefix) {
        const tableName = tablePrefix + name;
        if (!(await knex.schema.hasTable(tableName))) {
            return knex.schema.createTable(tableName, function (table) {
                table.increments('id').primary();
                table.text('content').notNullable();
                table.timestamps(false, true);
            });
        }
    }

    function data(input) {
        is.valid(
            is.objectWithProps({
                id: is.maybeNumber,
                content: is.maybeString,
                createdAt: is.maybeDate,
                updatedAt: is.maybeDate,
            }),
            arguments
        );
        return {
            id: input?.id,
            content: input?.content,
            created_at: input?.createdAt,
            updated_at: input?.updatedAt,
        };
    }

    return tie.define(name, schema, data);
};
```

**Note:** The component files used in the examples can be found in "./node_modules/tie-in/components/".

### All about tie.get

Syntax: `tie.get(comp, filters = {})`

When you pass a component instance to **tie.get**, it uses the arguments passed to the component instance for search. Here are some examples:

* `await tie.get(user( {country: 'JP'} ))` returns the users from Japan.
* `await tie.get(user( {country: 'JP', username: 'Asuka'} ))` returns the users from Japan having the username 'Asuka'.
* `await tie.get(user())` returns all users.

#### Filters

**downstreamLimit:**
Unless specified, get returns up to 10 levels of downstream related records. You can set this to another number or 0 for none.

**upstreamLimit:**
Unless specified, get returns up to 10 levels of upstream related records. You can set this to another number or 0 for none.

**filterUpstreamBy:**
Filters records by upstream relationships. Similar to an inner join.

```js
// Returns posts in topic #1
await tie.get(post(), { filterUpstreamBy: [topic({ id: 1 })] });

// Returns posts in topic #1 by user #2
await tie.get(post(), { filterUpstreamBy: [topic({ id: 1 }), user({ id: 2 })] });
```

**where:** 
Lets you use custom where clauses. For all available options, you can refer to [knex's documentation](https://knexjs.org/guide/query-builder.html#where-clauses). Note: Column names must be in snake_case when using this filter.

```js
// Returns topics created in 2024
await tie.get(topic(), { where: (query) => query.where('created_at', '>=', new Date('2024-01-01')) });
```

**aggregate:**
Runs an aggregate query. The following aggregate functions are supported: 'avg', 'avgDistinct', 'count', 'countDistinct', 'min', 'max', 'sum', 'sumDistinct'.

```js
// Returns post count
await tie.get(post(), { aggregate: [{ fn: 'count', args: '*' }] });
```

**group:**
Groups records. Must be used with an aggregate query.

```js
// Returns the number of posts made by each user
await tie.get(post(), {
    aggregate: [{ fn: 'count', args: '*' }],
    group: { by: user(), columns: ['id', 'username'] },
}); 
```

**orderBy:**
Orders records by given criteria.

```js
// Returns posts order by date in descending order
await tie.get(post(), { orderBy: [{ column: 'createdAt', order: 'desc' }] });
```

**offset:**
Returns records starting at specified offset. Defaults to 0.

**limit:**
Limits the number of records returned. Unless specified, get returns up to 10 results. Set to -1 for no limit.

Finally, here's an example that demonstrates multiple filters working together:

```js
async function getPostCountsGroupedByUser(topicId) {
    const filters = {
        aggregate: [{ fn: 'count', args: '*' }],
        group: { by: user(), columns: ['id', 'username'] },
        filterUpstreamBy: [topic({ id: topicId })],
        orderBy: [{ column: 'username', order: 'asc' }],
        limit: -1,
    };
    return tie.get(post(), filters);
}
```

### Other Methods

#### tie.register

Syntax: `tie.register(compCollection = [])`

All components must be registered with this method before use. Calls each component's schema method.

```js
// Register the user, post and topic components
tie.register([user, post, topic]);
```

#### tie.create

Syntax: `tie.create(comp, rels, trx)`

Creates a record based on the component instance (*comp*), and it optionally creates the record's relationships (*rels*). Returns the newly created record's id on success. You can also pass an optional knex transaction (*trx*) if you would like to run this operation inside a transaction as a part of other database operations.

Relationships can be upstream (referencing the newly created record) and/or downstream (referenced from the newly created record). Relationships can optionally have types specified by *relType*.

```js
// Create a new topic
const topicId = await tie.create(topic({ title: 'New Topic' }));
// Then create a post, assign a user and the newly created topic as its upstream relationship
const postId = await tie.create(post({ content: 'Something interesting' }), {
    upstream: [user({ id: someUserId, relType: 'starter' }), topic({ id: topicId })],
});
```

Alternatively, the above two operations can be run inside a database transaction to ensure all-or-none behavior:

```js
const postId = await tie.knex.transaction(async (trx) => {
    const topicId = await tie.create(topic({ title: 'New Topic' }), trx);
    return await tie.create(
        post({ content: 'Something interesting' }),
        {
            upstream: [user({ id: someUserId, relType: 'starter' }), topic({ id: topicId })],
        },
        trx
    );
});
```

#### tie.update

Syntax: `update(targetComp, targetFilters = {}, sourceComp, trx)`

Updates matching target component records retrieved by using *targetComp* and  *targetFilters* with sourceComp's data. You can also pass an optional knex transaction (*trx*) if you would like to run this operation inside a transaction as a part of other database operations.

The *targetFilters* object can optionally contain the **filterByUpstream** and **where** properties as described under [tie.get filters](https://github.com/aycangulez/tie-in#filters).

```js
// Updates user #1's e-mail address and updatedAt fields
await tie.update(user({ id: 1 }), {}, user({ email: 'asuka@elsewhere', updatedAt: new Date() }));
```

#### tie.del

Syntax: `tie.del(comp, filters = {}, trx)`

Deletes matching component records and their relationships. Related records will not be deleted. You can also pass an optional knex transaction (*trx*) if you would like to run this operation inside a transaction as a part of other database operations.

The *filters* object can optionally contain the **filterByUpstream** and **where** properties as described under [tie.get filters](https://github.com/aycangulez/tie-in#filters).

```js
await tie.del(post({ id: somePostId }));
```

#### tie.createRels

Syntax: `createRels(comp, rels, trx)`

Creates relationships between the records in *rels* and the component's record (*comp*). You can also pass an optional knex transaction (*trx*) if you would like to run this operation inside a transaction as a part of other database operations.

Related records can be upstream (referencing the newly created record) and/or downstream (referenced from the record). Related records can optionally have types specified by *relType*.

```js
await tie.createRels(post({ id: somePostId }), {
    upstream: [user({ id: someUserId }), topic({ id: someTopicId })],
});
```

#### tie.getRels

Syntax: `getRels(comp, filters = {}, trx)`

Retrieves the relationship mappings for matching component records. You can pass an optional knex transaction (*trx*) if you would like to run this operation inside a transaction as a part of other database operations.

The *filters* object can optionally contain the **filterByUpstream** and **where** properties as described under [tie.get filters](https://github.com/aycangulez/tie-in#filters).

```js
await tie.getRels(post({ id: 3 }));
```

The output will be in the following format:

```json
{
  "upstream": [
    {
      "id": 6,
      "sourceComp": "user",
      "sourceId": 2,
      "targetComp": "post",
      "targetId": 3,
      "type": null,
      "createdAt": "2024-03-28T13:28:59.175Z",
      "updatedAt": "2024-03-28T13:28:59.175Z"
    },
    {
      "id": 7,
      "sourceComp": "topic",
      "sourceId": 2,
      "targetComp": "post",
      "targetId": 3,
      "type": null,
      "createdAt": "2024-03-28T13:28:59.175Z",
      "updatedAt": "2024-03-28T13:28:59.175Z"
    }
  ],
  "downstream": []
}
```

---

### Tie-in Library Arguments

Tie-in accepts three arguments when you load the library.

* **knexConfig:** Database configuration (required)
* **tablePrefix:** A prefix that is added to the beginning of component table names (defaults to '').
* **is:** An fn-arg-validator instance (optional).

Once the library is loaded, the following two properties can be used:

* **tie.is:** An fn-arg-validator instance.
* **tie.knex:** A knex instance.
