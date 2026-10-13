'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'public', 'online.html'), 'utf8');
const home = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

test('选牌后点击出牌按钮发送所选牌的真实 cardId', () => {
  assert.match(client, /socket\.emit\('game:playCard',\{roomCode,cardId:selected\}\)/);
  assert.doesNotMatch(client, /cardId:selected\.id/);
});

test('手机双击同一张合法牌走直接出牌路径', () => {
  assert.match(client, /selected===card\.id&&lastTapId===card\.id&&now-lastTapAt<=560/);
  assert.match(client, /socket\.emit\('game:playCard',\{roomCode,cardId:card\.id\}\)/);
});

test('入口同时提供本地单机与好友联机入口', () => {
  assert.match(home, /local\.html/);
  assert.match(home, /online\.html/);
});
