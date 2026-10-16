import { DurableObject } from 'cloudflare:workers';
import Stripe from 'stripe';
import serverModule from '../server.js';
import { CloudflareStore, loginAttempts } from './store.mjs';
import { fetchResponse } from './http.mjs';
import regularFont from '../node_modules/@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff';
import boldFont from '../node_modules/@fontsource/noto-sans/files/noto-sans-latin-700-normal.woff';

const { createApplication, STATIC_FILES } = serverModule;
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
function errorResponse(status, error) {
  return Response.json({ error }, { status, headers: { ...securityHeaders, 'Cache-Control': 'no-store' } });
}

export class ProfitPulseDatabase extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = new CloudflareStore(ctx.storage);
    this.application = createApplication({
      store: this.store,
      startTimers: false,
      backupLimit: 8 * 1024 * 1024,
      publicOrigin: env.PUBLIC_ORIGIN,
      production: new URL(env.PUBLIC_ORIGIN).protocol === 'https:',
      attempts: loginAttempts(this.store.db),
      adminEmails: env.PLATFORM_ADMIN_EMAILS || '',
      adminEmailHashes: env.PLATFORM_ADMIN_EMAIL_SHA256 || '',
      adminSetup:{tokenHash:env.PLATFORM_ADMIN_SETUP_TOKEN_SHA256,emailHash:env.PLATFORM_ADMIN_SETUP_EMAIL_SHA256,expiresAt:env.PLATFORM_ADMIN_SETUP_EXPIRES_AT,mode:env.PLATFORM_ADMIN_SETUP_MODE},
      channels:{meta:{appId:env.META_APP_ID,appSecret:env.META_APP_SECRET,version:env.META_API_VERSION},background:task=>ctx.waitUntil(task)},
      pdfFonts: { regular: Buffer.from(regularFont), bold: Buffer.from(boldFont) },
      billing: {
        stripe: env.STRIPE_SECRET_KEY ? new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient(), maxNetworkRetries: 2, timeout: 20000 }) : null,
        webhookSecret: env.STRIPE_WEBHOOK_SECRET,
        prices: JSON.parse(env.STRIPE_PRICES_JSON || '{}'),
      },
    });
  }
  fetch(request) { return fetchResponse(this.application.handleRequest, request); }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      if (!env.DATABASE || !env.PUBLIC_ORIGIN) return errorResponse(503, 'The workspace service is not configured. Please contact the service operator.');
      try {
        // One database preserves globally unique emails and the existing tenant model.
        return await env.DATABASE.get(env.DATABASE.idFromName('profitpulse-v3')).fetch(request);
      } catch (error) {
        console.error('Workspace service failed:', error.message);
        return errorResponse(503, 'The workspace service is temporarily unavailable. Please try again shortly.');
      }
    }
    if (!['GET', 'HEAD'].includes(request.method)) return errorResponse(405, 'Method not allowed.');
    const file = STATIC_FILES[url.pathname];
    if (!file) return errorResponse(404, 'Not found.');
    // run_worker_first + html_handling:none keeps / public and /login explicit.
    const assetURL = new URL('/' + file, url.origin);
    const asset = await env.ASSETS.fetch(new Request(assetURL, { method: request.method }));
    if (!asset.ok) return errorResponse(503, 'The page is temporarily unavailable. Please try again shortly.');
    const headers = new Headers(asset.headers);
    for (const [name, value] of Object.entries(securityHeaders)) headers.set(name, value);
    headers.set('Cache-Control', 'no-cache');
    if(url.pathname==='/enquire'){
      if(!env.DATABASE)return errorResponse(503,'The enquiry form is unavailable.');
      const infoURL=new URL('/api/capture/'+encodeURIComponent(url.searchParams.get('site')||'missing')+'/info',url.origin);
      const response=await env.DATABASE.get(env.DATABASE.idFromName('profitpulse-v3')).fetch(new Request(infoURL));
      if(!response.ok)return errorResponse(404,'This enquiry form is unavailable.');
      const info=await response.json();headers.delete('X-Frame-Options');headers.set('Content-Security-Policy',securityHeaders['Content-Security-Policy'].replace("frame-ancestors 'none'",'frame-ancestors '+info.websiteOrigin));headers.set('Cache-Control','no-store');
    }
    if (url.protocol === 'https:') headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    return new Response(asset.body, { status: asset.status, headers });
  },
};
