# fn-comp

fn-comp is a relational data component library that makes it easy to store and query records that can be related to any other record.

## Installation

```bash
npm install --save fn-comp
```

## Usage

First, let's go over a quick example where we model a simple forum.

By using data components, we create a user, a post, and a topic in the relational database of our choice (in this case PostgreSQL):

```js
const dbConfig = {
    client: 'pg',
    connection: 'postgresql://localhost/me'
};

// Load fn-comp and data component definitions
const comp = require('fn-comp')(dbConfig);
const user = require('./components/user')(comp);
const post = require('./components/post')(comp);
const topic = require('./components/topic')(comp);

// Register the components we will use
comp.register([user, post, topic]))

// Create a user named Asuka
const userId = await comp.create(user({ username: 'Asuka', email: 'asuka@localhost' });

// Create a post and make its author Asuka
const postId = await comp.create(post({ content: 'Hi!' }), {
    upstream: [user({ id: postId, relType: 'author' })]
});

// Create a topic and make the topic starter Asuka, also make the post a child of this topic
const topicId = await comp.create(topic({ title: 'First Topic' }), {
    upstream: [user({ id: userId, relType: 'starter' })],
    downstream: [post({ id: postId, relType: 'child' })],
});
```

Now the individual records and their relations are in place, we can retrieve the newly created topic with **comp.get**,  which retrieves all the relations grouped together.

```js
console.log(await comp.get(topic( {id: topicId} )));

{
    "topic": [
        {
            "self": {
                "id": 1,
                "title": "First Topic",
                "createdAt": "2024-03-23T20:45:45.131Z",
                "updatedAt": "2024-03-23T20:45:45.131Z"
            },
            "user": [
                {
                    "self": {
                        "relType": "starter",
                        "id": 1,
                        "username": "Asuka",
                        "email": "asuka@localhost",
                        "createdAt": "2024-03-23T20:45:45.107Z",
                        "updatedAt": "2024-03-23T20:45:45.118Z"
                    }
                }
            ],
            "post": [
                {
                    "self": {
                        "relType": "child",
                        "id": 1,
                        "content": "Hi!",
                        "createdAt": "2024-03-23T20:45:45.124Z",
                        "updatedAt": "2024-03-23T20:45:45.124Z"
                    }
                }
            ]
        }
    ]
}
```

### Highly Granular Relations

The relations in a database are usually defined between columns across tables. In fn-comp, however, relations can be defined between individual records. Relations can also have types, so you can have multiple relations between two records.

The ability to associate a record with any other record on any table opens up new possibilities that are hard to accomplish with the traditional column-based relations. Also, since relations are dynamic, no schema changes are necessary to define new relations.

### Defining Components

To define a component, you call **comp.define** with the following arguments.

* **name:** Name of the component

* **schema:** A function that defines the database table schema. fn-comp uses [knex](https://knexjs.org) under the hood. Table field names must be in snake_case for maximum compatibility across different database systems. This function is called when you register components with **comp.register**.

* **data:** A function that accepts an object with field names in camelCase, which are mapped to the database table fields.

In its simplest form, a component definition should look like the example below. All components must have a field named *id* that uniquely identifies a record.

```js
module.exports = (comp) => {
    const name = 'user';

    async function schema(knex, tablePrefix = '') {
        const tableName = tablePrefix + name;
        if (!(await knex.schema.hasTable(tableName))) {
            return knex.schema.createTable(tableName, function (table) {
                table.increments('id').primary();
                table.string('username').notNullable();
                table.string('email').notNullable();
                table.timestamps(false, true);
                table.unique('email');
            });
        }
    }

    function data(input) {
        return {
            id: input?.id,
            username: input?.username,
            email: input?.email,
            created_at: input?.createdAt,
            updated_at: input?.updatedAt,
        };
    }

    return comp.define(name, schema, data);
};
```

It's probably a good idea to validate the input passed to the **data** function. fn-comp uses [fn-arg-validator](https://www.npmjs.com/package/fn-arg-validator) for internal data validation, and exposes it through **comp.is**, but you can of course use any other library you would like. Here's another component with data validation in place:

```js
module.exports = (comp) => {
    const is = comp.is;
    const name = 'post';

    async function schema(knex, tablePrefix = '') {
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

    return comp.define(name, schema, data);
};
```
