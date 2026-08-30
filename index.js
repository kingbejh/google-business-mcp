/**
 * Google Business Profile MCP Server — Cloud Edition
 * Runs as HTTP+SSE server on Render (or any cloud host)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import express from 'express';
import { google } from 'googleapis';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { z } from 'zod';

// Config
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const PORT = parseInt(process.env.PORT || '3000');
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const REDIRECT_URI = `${BASE_URL}/auth/callback`;
const SCOPES = ['https://www.googleapis.com/auth/business.manage'];

// OAuth Client
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

function loadTokens() {
  if (process.env.GOOGLE_TOKENS) {
    try { const t = JSON.parse(process.env.GOOGLE_TOKENS); oauth2Client.setCredentials(t); return true; } catch { return false; }
  }
  if (existsSync('tokens.json')) {
    const t = JSON.parse(readFileSync('tokens.json', 'utf-8')); oauth2Client.setCredentials(t); return true;
  }
  return false;
}

function saveTokens(tokens) {
  writeFileSync('tokens.json', JSON.stringify(tokens, null, 2));
  oauth2Client.setCredentials(tokens);
}

oauth2Client.on('tokens', (n) => {
  try {
    let e = {}; if (existsSync('tokens.json')) e = JSON.parse(readFileSync('tokens.json', 'utf-8'));
    saveTokens({ ...e, ...n });
  } catch {}
});

const hasTokens = loadTokens();

async function apiRequest(url, options = {}) {
  const accessToken = (await oauth2Client.getAccessToken()).token;
  const method = options.method || 'GET';
  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', ...options.headers };
  const fetchOptions = { method, headers };
  if (options.body) fetchOptions.body = JSON.stringify(options.body);
  const resp = await fetch(url, fetchOptions);
  const text = await resp.text();
  if (!resp.ok) throw new Error(`API ${resp.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

const GBP_BASE = 'https://mybusinessbusinessinformation.googleapis.com/v1';
const ACCOUNT_BASE = 'https://mybusinessaccountmanagement.googleapis.com/v1';
const PERF_BASE = 'https://businessprofileperformance.googleapis.com/v1';

const mcpServer = new McpServer({ name: 'google-business-profile', version: '1.0.0' });

mcpServer.tool('list_accounts', 'List all Google Business Profile accounts', {}, async () => {
  try {
    const data = await apiRequest(`${ACCOUNT_BASE}/accounts`);
    const accounts = (data.accounts || []).map(a => ({ name: a.name, accountName: a.accountName, type: a.type, role: a.role }));
    return { content: [{ type: 'text', text: JSON.stringify(accounts, null, 2) }] };
  } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }; }
});

mcpServer.tool('list_locations', 'List all business locations for an account', {
  accountName: z.string().describe('Account resource name, e.g. accounts/123456789'),
}, async ({ accountName }) => {
  try {
    const readMask = 'name,title,storefrontAddress,websiteUri,phoneNumbers,categories,profile,openInfo,metadata';
    const data = await apiRequest(`${GBP_BASE}/${accountName}/locations?readMask=${readMask}`);
    const locations = (data.locations || []).map(l => ({ name: l.name, title: l.title, address: l.storefrontAddress, phone: l.phoneNumbers, website: l.websiteUri, description: l.profile?.description }));
    return { content: [{ type: 'text', text: JSON.stringify(locations, null, 2) }] };
  } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }; }
});

mcpServer.tool('get_location', 'Get detailed info for a specific business location', {
  locationName: z.string().describe('Location resource name, e.g. locations/123456789'),
}, async ({ locationName }) => {
  try {
    const readMask = 'name,title,storefrontAddress,websiteUri,phoneNumbers,categories,profile,openInfo,regularHours,specialHours,metadata,serviceArea,latlng';
    const data = await apiRequest(`${GBP_BASE}/${locationName}?readMask=${readMask}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }; }
});

mcpServer.tool('update_location', 'Update business info (description, phone, website, hours, etc.)', {
  locationName: z.string().describe('Location resource name'),
  updateMask: z.string().describe('Comma-separated fields to update'),
  updateData: z.string().describe('JSON string of the location fields to update'),
}, async ({ locationName, updateMask, updateData }) => {
  try {
    const body = JSON.parse(updateData);
    const data = await apiRequest(`${GBP_BASE}/${locationName}?updateMask=${updateMask}`, { method: 'PATCH', body });
    return { content: [{ type: 'text', text: `Updated!\n${JSON.stringify(data, null, 2)}` }] };
  } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }; }
});

mcpServer.tool('list_reviews', 'List customer reviews for a location', {
  accountName: z.string().describe('Account resource name'),
  locationId: z.string().describe('Location ID (number)'),
  pageSize: z.number().optional().describe('Number of reviews (default 10)'),
}, async ({ accountName, locationId, pageSize }) => {
  try {
    const data = await apiRequest(`https://mybusiness.googleapis.com/v4/${accountName}/locations/${locationId}/reviews?pageSize=${pageSize || 10}`);
    const reviews = (data.reviews || []).map(r => ({ reviewId: r.reviewId, reviewer: r.reviewer?.displayName, rating: r.starRating, comment: r.comment, createTime: r.createTime, reply: r.reviewReply?.comment }));
    return { content: [{ type: 'text', text: `Total: ${data.totalReviewCount || 0} | Avg: ${data.averageRating || 'N/A'}\n\n${JSON.stringify(reviews, null, 2)}` }] };
  } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }; }
});

mcpServer.tool('reply_review', 'Reply to a customer review', {
  accountName: z.string(), locationId: z.string(), reviewId: z.string(), replyText: z.string(),
}, async ({ accountName, locationId, reviewId, replyText }) => {
  try {
    const data = await apiRequest(`https://mybusiness.googleapis.com/v4/${accountName}/locations/${locationId}/reviews/${reviewId}/reply`, { method: 'PUT', body: { comment: replyText } });
    return { content: [{ type: 'text', text: `Reply posted!\n${JSON.stringify(data, null, 2)}` }] };
  } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }; }
});

mcpServer.tool('create_post', 'Create a new post/update on your business profile', {
  accountName: z.string(), locationId: z.string(), summary: z.string(),
  topicType: z.enum(['STANDARD', 'EVENT', 'OFFER']).optional(),
  mediaUrl: z.string().optional(), mediaFormat: z.enum(['PHOTO', 'VIDEO']).optional(),
  callToActionType: z.string().optional(), callToActionUrl: z.string().optional(),
}, async ({ accountName, locationId, summary, topicType, mediaUrl, mediaFormat, callToActionType, callToActionUrl }) => {
  try {
    const post = { topicType: topicType || 'STANDARD', summary, languageCode: 'id' };
    if (mediaUrl) post.media = [{ mediaFormat: mediaFormat || 'PHOTO', sourceUrl: mediaUrl }];
    if (callToActionType) post.callToAction = { actionType: callToActionType, url: callToActionUrl };
    const data = await apiRequest(`https://mybusiness.googleapis.com/v4/${accountName}/locations/${locationId}/localPosts`, { method: 'POST', body: post });
    return { content: [{ type: 'text', text: `Post created!\n${JSON.stringify(data, null, 2)}` }] };
  } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }; }
});

mcpServer.tool('list_posts', 'List all posts for a location', {
  accountName: z.string(), locationId: z.string(), pageSize: z.number().optional(),
}, async ({ accountName, locationId, pageSize }) => {
  try {
    const data = await apiRequest(`https://mybusiness.googleapis.com/v4/${accountName}/locations/${locationId}/localPosts?pageSize=${pageSize || 10}`);
    const posts = (data.localPosts || []).map(p => ({ name: p.name, summary: p.summary, topicType: p.topicType, state: p.state, createTime: p.createTime, searchUrl: p.searchUrl }));
    return { content: [{ type: 'text', text: JSON.stringify(posts, null, 2) }] };
  } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }; }
});

mcpServer.tool('delete_post', 'Delete a post from a location', {
  postName: z.string().describe('Full post resource name'),
}, async ({ postName }) => {
  try {
    await apiRequest(`https://mybusiness.googleapis.com/v4/${postName}`, { method: 'DELETE' });
    return { content: [{ type: 'text', text: `Post deleted: ${postName}` }] };
  } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }; }
});

mcpServer.tool('get_insights', 'Get performance metrics for a location', {
  locationName: z.string(), startDate: z.string().describe('YYYY-MM-DD'), endDate: z.string().describe('YYYY-MM-DD'),
}, async ({ locationName, startDate, endDate }) => {
  try {
    const metrics = 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS,BUSINESS_IMPRESSIONS_DESKTOP_SEARCH,BUSINESS_IMPRESSIONS_MOBILE_MAPS,BUSINESS_IMPRESSIONS_MOBILE_SEARCH,BUSINESS_DIRECTION_REQUESTS,CALL_CLICKS,WEBSITE_CLICKS';
    const [sY, sM, sD] = startDate.split('-').map(Number);
    const [eY, eM, eD] = endDate.split('-').map(Number);
    const data = await apiRequest(`${PERF_BASE}/${locationName}:getDailyMetricsTimeSeries?dailyMetrics=${metrics}&dailyRange.startDate.year=${sY}&dailyRange.startDate.month=${sM}&dailyRange.startDate.day=${sD}&dailyRange.endDate.year=${eY}&dailyRange.endDate.month=${eM}&dailyRange.endDate.day=${eD}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }; }
});

mcpServer.tool('list_questions', 'List Q&A questions for a location', {
  locationName: z.string(), pageSize: z.number().optional(),
}, async ({ locationName, pageSize }) => {
  try {
    const data = await apiRequest(`https://mybusinessqanda.googleapis.com/v1/${locationName}/questions?pageSize=${pageSize || 10}`);
    const questions = (data.questions || []).map(q => ({ name: q.name, text: q.text, createTime: q.createTime, upvoteCount: q.upvoteCount, totalAnswerCount: q.totalAnswerCount, topAnswers: (q.topAnswers || []).map(a => ({ text: a.text, createTime: a.createTime })) }));
    return { content: [{ type: 'text', text: JSON.stringify(questions, null, 2) }] };
  } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }; }
});

mcpServer.tool('answer_question', 'Answer a Q&A question on your business profile', {
  questionName: z.string(), answerText: z.string(),
}, async ({ questionName, answerText }) => {
  try {
    const data = await apiRequest(`https://mybusinessqanda.googleapis.com/v1/${questionName}/answers:upsert`, { method: 'POST', body: { text: answerText } });
    return { content: [{ type: 'text', text: `Answer posted!\n${JSON.stringify(data, null, 2)}` }] };
  } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }; }
});

mcpServer.tool('get_search_keywords', 'Get top search keywords for your business', {
  locationName: z.string(), startDate: z.string(), endDate: z.string(),
}, async ({ locationName, startDate, endDate }) => {
  try {
    const [sY, sM] = startDate.split('-').map(Number);
    const [eY, eM] = endDate.split('-').map(Number);
    const data = await apiRequest(`${PERF_BASE}/${locationName}/searchkeywords/impressions/monthly?monthlyRange.startMonth.year=${sY}&monthlyRange.startMonth.month=${sM}&monthlyRange.endMonth.year=${eY}&monthlyRange.endMonth.month=${eM}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }; }
});

const app = express();

app.get('/', (req, res) => {
  res.json({ status: 'ok', server: 'google-business-profile-mcp', authenticated: hasTokens, authUrl: hasTokens ? null : `${BASE_URL}/auth` });
});

app.get('/auth', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });
  res.redirect(authUrl);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code');
  try {
    const { tokens } = await oauth2Client.getToken(code);
    saveTokens(tokens);
    res.send('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h1>Berhasil!</h1><p>Google Business Profile terhubung. Token tersimpan.</p></body></html>');
  } catch (err) { res.status(500).send(`Error: ${err.message}`); }
});

const transports = {};

app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  transports[transport.sessionId] = transport;
  res.on('close', () => { delete transports[transport.sessionId]; });
  await mcpServer.connect(transport);
});

app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];
  if (!transport) return res.status(404).send('Session not found');
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    try { await transport.handlePostMessage(req, res, JSON.parse(body)); } catch (e) { res.status(400).json({ error: e.message }); }
  });
});

app.listen(PORT, () => {
  console.log(`Google Business Profile MCP Server running on port ${PORT}`);
  console.log(`MCP SSE endpoint: ${BASE_URL}/sse`);
  if (!hasTokens) console.log(`Auth required: visit ${BASE_URL}/auth`);
});
