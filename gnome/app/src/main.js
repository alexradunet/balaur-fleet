// Entry point: `gjs -m main.js`.

import {exit, programArgs, programInvocationName} from 'system';

import {BalaurApplication} from './application.js';

const status = await new BalaurApplication().runAsync([programInvocationName, ...programArgs]);
exit(status);
