// balaur-assistant: the Balaur home server's voice assistant ("Hey Jarvis"), a
// GNOME session service. See README.md and gnome/CONTRACT.md.

import System from 'system';

import {BalaurAssistantApp} from './application.js';

const app = new BalaurAssistantApp();
const status = await app.runAsync([System.programInvocationName, ...System.programArgs]);
System.exit(status);
