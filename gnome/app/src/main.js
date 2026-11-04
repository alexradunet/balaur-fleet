// Entry point: `gjs -m main.js`.

import {exit, programArgs, programInvocationName} from 'system';

import {DuetApplication} from './application.js';

const status = await new DuetApplication().runAsync([programInvocationName, ...programArgs]);
exit(status);
