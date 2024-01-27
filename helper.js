const is = require('fn-arg-validator');
is.config.throw = process.env.FN_COMP_ARG_VALIDATOR_THROW;

const helper = {
    is,
};

module.exports = helper;
