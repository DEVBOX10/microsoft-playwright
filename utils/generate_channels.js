#!/usr/bin/env node
/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// @ts-check

const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('yaml');

const channels = new Set();
const inherits = new Map();
const mixins = new Map();

function raise(item) {
  throw new Error('Invalid item: ' + JSON.stringify(item, null, 2));
}

function titleCase(name) {
  return name[0].toUpperCase() + name.substring(1);
}

function inlineType(type, indent, wrapEnums = false) {
  if (typeof type === 'string') {
    const optional = type.endsWith('?');
    if (optional)
      type = type.substring(0, type.length - 1);
    if (type === 'binary')
      return { ts: 'Binary', scheme: 'tBinary', optional };
    if (type === 'json')
      return { ts: 'any', scheme: 'tAny', optional };
    if (['string', 'boolean', 'number', 'undefined'].includes(type))
      return { ts: type, scheme: `t${titleCase(type)}`, optional };
    if (channels.has(type))
      return { ts: `${type}Channel`, scheme: `tChannel('${type}')` , optional };
    if (type === 'Channel')
      return { ts: `Channel`, scheme: `tChannel('*')`, optional };
    return { ts: type, scheme: `tType('${type}')`, optional };
  }
  if (type.type.startsWith('array')) {
    const optional = type.type.endsWith('?');
    const inner = inlineType(type.items, indent, true);
    return { ts: `${inner.ts}[]`, scheme: `tArray(${inner.scheme})`, optional };
  }
  if (type.type.startsWith('enum')) {
    const optional = type.type.endsWith('?');
    const ts = type.literals.map(literal => `'${literal}'`).join(' | ');
    return {
      ts: wrapEnums ? `(${ts})` : ts,
      scheme: `tEnum([${type.literals.map(literal => `'${literal}'`).join(', ')}])`,
      optional
    };
  }
  if (type.type.startsWith('object')) {
    const optional = type.type.endsWith('?');
    const inner = properties(type.properties, indent + '  ');
    return {
      ts: `{\n${inner.ts}\n${indent}}`,
      scheme: `tObject({\n${inner.scheme}\n${indent}})`,
      optional
    };
  }
  raise(type);
}

function properties(properties, indent, onlyOptional) {
  const ts = [];
  const scheme = [];
  const visitProperties = props => {
    for (const [name, value] of Object.entries(props)) {
      if (name.startsWith('$mixin')) {
        visitProperties(mixins.get(value).properties);
        continue;
      }
      const inner = inlineType(value, indent);
      if (onlyOptional && !inner.optional)
        continue;
      ts.push(`${indent}${name}${inner.optional ? '?' : ''}: ${inner.ts},`);
      const wrapped = inner.optional ? `tOptional(${inner.scheme})` : inner.scheme;
      scheme.push(`${indent}${name}: ${wrapped},`);
    }
  };
  visitProperties(properties);
  return { ts: ts.join('\n'), scheme: scheme.join('\n') };
}

function objectType(props, indent, onlyOptional = false) {
  if (!Object.entries(props).length)
    return { ts: `{}`, scheme: `tObject({})` };
  const inner = properties(props, indent + '  ', onlyOptional);
  return { ts: `{\n${inner.ts}\n${indent}}`, scheme: `tObject({\n${inner.scheme}\n${indent}})` };
}

const channels_ts = [
`/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// This file is generated by ${path.basename(__filename).split(path.sep).join(path.posix.sep)}, do not edit manually.

export type Binary = string;

export interface Channel {
}
`];

const validator_ts = [
`/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// This file is generated by ${path.basename(__filename)}, do not edit manually.

import type { Validator } from './validatorPrimitives';
import { ValidationError, tOptional, tObject, tBoolean, tNumber, tString, tAny, tEnum, tArray, tBinary } from './validatorPrimitives';
export type { Validator } from './validatorPrimitives';
export { ValidationError } from './validatorPrimitives';

type Scheme = { [key: string]: Validator };

export function createScheme(tChannel: (name: string) => Validator): Scheme {
  const scheme: Scheme = {};

  const tType = (name: string): Validator => {
    return (arg: any, path: string) => {
      const v = scheme[name];
      if (!v)
        throw new ValidationError(path + ': unknown type "' + name + '"');
      return v(arg, path);
    };
  };
`];

const tracingSnapshots = [];
const pausesBeforeInputActions = [];

const yml = fs.readFileSync(path.join(__dirname, '..', 'packages', 'playwright-core', 'src', 'protocol', 'protocol.yml'), 'utf-8');
const protocol = yaml.parse(yml);

function addScheme(name, s) {
  const lines = `scheme.${name} = ${s};`.split('\n');
  validator_ts.push(...lines.map(line => '  ' + line));
}

for (const [name, value] of Object.entries(protocol)) {
  if (value.type === 'interface') {
    channels.add(name);
    if (value.extends)
      inherits.set(name, value.extends);
  }
  if (value.type === 'mixin')
    mixins.set(name, value);
}

const derivedClasses = new Map();
for (const [name, item] of Object.entries(protocol)) {
  if (item.type === 'interface' && item.extends) {
    let items = derivedClasses.get(item.extends);
    if (!items) {
      items = [];
      derivedClasses.set(item.extends, items);
    }
    items.push(name);
  }
}

channels_ts.push(`// ----------- Initializer Traits -----------`);
channels_ts.push(`export type InitializerTraits<T> =`);
const entriesInReverse = Object.entries(protocol).reverse();
for (const [name, item] of entriesInReverse) {
  if (item.type !== 'interface')
    continue;
  channels_ts.push(`    T extends ${name}Channel ? ${name}Initializer :`);
}
channels_ts.push(`    object;`);
channels_ts.push(``);
channels_ts.push(`// ----------- Event Traits -----------`);
channels_ts.push(`export type EventsTraits<T> =`);
for (const [name, item] of entriesInReverse) {
  if (item.type !== 'interface')
    continue;
  channels_ts.push(`    T extends ${name}Channel ? ${name}Events :`);
}
channels_ts.push(`    undefined;`);
channels_ts.push(``);
channels_ts.push(`// ----------- EventTarget Traits -----------`);
channels_ts.push(`export type EventTargetTraits<T> =`);
for (const [name, item] of entriesInReverse) {
  if (item.type !== 'interface')
    continue;
  channels_ts.push(`    T extends ${name}Channel ? ${name}EventTarget :`);
}
channels_ts.push(`    undefined;`);
channels_ts.push(``);

for (const [name, item] of Object.entries(protocol)) {
  if (item.type === 'interface') {
    const channelName = name;
    channels_ts.push(`// ----------- ${channelName} -----------`);
    const init = objectType(item.initializer || {}, '');
    const initializerName = channelName + 'Initializer';
    channels_ts.push(`export type ${initializerName} = ${init.ts};`);

    channels_ts.push(`export interface ${channelName}EventTarget {`);
    const ts_types = new Map();

    /** @type{{eventName: string, eventType: string}[]} */
    const eventTypes = [];
    for (let [eventName, event] of Object.entries(item.events || {})) {
      if (event === null)
        event = {};
      const parameters = objectType(event.parameters || {}, '');
      const paramsName = `${channelName}${titleCase(eventName)}Event`;
      ts_types.set(paramsName, parameters.ts);
      channels_ts.push(`  on(event: '${eventName}', callback: (params: ${paramsName}) => void): this;`);
      eventTypes.push({eventName, eventType: paramsName});
    }
    channels_ts.push(`}`);

    channels_ts.push(`export interface ${channelName}Channel extends ${channelName}EventTarget, ${(item.extends || '') + 'Channel'} {`);
    channels_ts.push(`  _type_${channelName}: boolean;`);
    for (let [methodName, method] of Object.entries(item.commands || {})) {
      if (method === null)
        method = {};
      if (method.tracing && method.tracing.snapshot) {
        tracingSnapshots.push(name + '.' + methodName);
        for (const derived of derivedClasses.get(name) || [])
          tracingSnapshots.push(derived + '.' + methodName);
      }
      if (method.tracing && method.tracing.pausesBeforeInput) {
        pausesBeforeInputActions.push(name + '.' + methodName);
        for (const derived of derivedClasses.get(name) || [])
          pausesBeforeInputActions.push(derived + '.' + methodName);
      }
      const parameters = objectType(method.parameters || {}, '');
      const paramsName = `${channelName}${titleCase(methodName)}Params`;
      const optionsName = `${channelName}${titleCase(methodName)}Options`;
      ts_types.set(paramsName, parameters.ts);
      ts_types.set(optionsName, objectType(method.parameters || {}, '', true).ts);
      addScheme(paramsName, method.parameters ? parameters.scheme : `tOptional(tObject({}))`);
      for (const key of inherits.keys()) {
        if (inherits.get(key) === channelName)
          addScheme(`${key}${titleCase(methodName)}Params`, `tType('${paramsName}')`);
      }

      const resultName = `${channelName}${titleCase(methodName)}Result`;
      const returns = objectType(method.returns || {}, '');
      ts_types.set(resultName, method.returns ? returns.ts : 'void');

      channels_ts.push(`  ${methodName}(params${method.parameters ? '' : '?'}: ${paramsName}, metadata?: Metadata): Promise<${resultName}>;`);
    }

    channels_ts.push(`}`);
    for (const [typeName, typeValue] of ts_types)
      channels_ts.push(`export type ${typeName} = ${typeValue};`);
    channels_ts.push(``);

    channels_ts.push(`export interface ${channelName}Events {`);
    for (const {eventName, eventType} of eventTypes)
        channels_ts.push(`  '${eventName}': ${eventType};`);
    channels_ts.push(`}\n`);

  } else if (item.type === 'object') {
    const inner = objectType(item.properties, '');
    channels_ts.push(`export type ${name} = ${inner.ts};`);
    channels_ts.push(``);
    addScheme(name, inner.scheme);
  } else if (item.type === 'enum') {
    const ts = item.literals.map(literal => `'${literal}'`).join(' | ');
    channels_ts.push(`export type ${name} = ${ts};`)
    addScheme(name, `tEnum([${item.literals.map(literal => `'${literal}'`).join(', ')}])`);
  }
}

channels_ts.push(`export const commandsWithTracingSnapshots = new Set([
  '${tracingSnapshots.join(`',\n  '`)}'
]);`);
channels_ts.push('');
channels_ts.push(`export const pausesBeforeInputActions = new Set([
  '${pausesBeforeInputActions.join(`',\n  '`)}'
]);`);

validator_ts.push(`
  return scheme;
}
`);

let hasChanges = false;

function writeFile(filePath, content) {
  const existing = fs.readFileSync(filePath, 'utf8');
  if (existing === content)
    return;
  hasChanges = true;
  const root = path.join(__dirname, '..');
  console.log(`Writing //${path.relative(root, filePath)}`);
  fs.writeFileSync(filePath, content, 'utf8');
}

writeFile(path.join(__dirname, '..', 'packages', 'playwright-core', 'src', 'protocol', 'channels.ts'), channels_ts.join('\n'));
writeFile(path.join(__dirname, '..', 'packages', 'playwright-core', 'src', 'protocol', 'validator.ts'), validator_ts.join('\n'));
process.exit(hasChanges ? 1 : 0);
