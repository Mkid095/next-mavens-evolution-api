/**
 * V1 Branded API Router
 *
 * All endpoints under /api/v1/* are branded endpoints that provide
 * the same functionality as the base API but under a branded namespace.
 *
 * This allows white-labeling and custom domain configurations.
 * Branding is fetched dynamically from centralized config.
 *
 * Base path: /api/v1
 */

import { Router } from 'express';
import { configService } from '@config/env.config';

import { HttpStatus } from './index.router';

const router: Router = Router();

/**
 * Get dynamic branding configuration
 * Centralized - fetches from BRANDING config
 */
router.get('/config/branding', (req, res) => {
  const branding = configService.get('BRANDING');
  const serverUrl = configService.get('SERVER').URL;

  res.status(HttpStatus.OK).json({
    companyName: branding.COMPANY_NAME,
    productName: branding.PRODUCT_NAME,
    logoUrl: branding.LOGO_URL.startsWith('/')
      ? `${serverUrl}${branding.LOGO_URL}`
      : branding.LOGO_URL,
    faviconUrl: branding.FAVICON_URL.startsWith('/')
      ? `${serverUrl}${branding.FAVICON_URL}`
      : branding.FAVICON_URL,
    primaryColor: branding.PRIMARY_COLOR,
    secondaryColor: branding.SECONDARY_COLOR,
    accentColor: branding.ACCENT_COLOR,
    supportEmail: branding.SUPPORT_EMAIL,
    websiteUrl: branding.WEBSITE_URL,
    termsOfServiceUrl: branding.TERMS_URL,
    privacyPolicyUrl: branding.PRIVACY_URL,
    version: '1.0.0',
  });
});

/**
 * Get dynamic domain configuration
 * Centralized - fetches from DOMAIN config
 */
router.get('/config/domain', (req, res) => {
  const domain = configService.get('DOMAIN');
  const serverUrl = configService.get('SERVER').URL;
  const serverType = configService.get('SERVER').TYPE;

  res.status(HttpStatus.OK).json({
    apiBaseUrl: serverUrl,
    apiVersion: 'v1',
    domain: domain.CUSTOM_DOMAIN || serverUrl,
    sslEnabled: serverType === 'https',
    cdnUrl: domain.CDN_URL || `${serverUrl}/cdn`,
    docsUrl: domain.DOCS_URL,
    supportUrl: domain.SUPPORT_URL,
  });
});

/**
 * Get platform status
 */
router.get('/status', async (req, res) => {
  try {
    res.status(HttpStatus.OK).json({
      status: 'operational',
      platform: 'whatsapp-api',
      version: '1.0.0',
      branding: {
        company: configService.get('BRANDING').COMPANY_NAME,
        product: configService.get('BRANDING').PRODUCT_NAME,
      },
      features: {
        baileys: true,
        businessApi: true,
        webhooks: true,
        antiBan: true,
        campaign: true,
        analytics: true,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      status: 'error',
      message: error.message,
    });
  }
});

/**
 * API documentation
 */
router.get('/', (req, res) => {
  const branding = configService.get('BRANDING');
  const serverUrl = configService.get('SERVER').URL;

  res.status(HttpStatus.OK).json({
    name: branding.PRODUCT_NAME,
    version: '1.0.0',
    description: `Enterprise WhatsApp API by ${branding.COMPANY_NAME}`,
    documentation: `${serverUrl}/docs/api/FULL_API_REFERENCE.md`,
    endpoints: {
      config: {
        'GET /api/v1/config/branding': 'Get branding configuration',
        'GET /api/v1/config/domain': 'Get domain configuration',
      },
      status: {
        'GET /api/v1/status': 'Platform status',
      },
    },
    support: branding.SUPPORT_EMAIL,
    website: branding.WEBSITE_URL,
  });
});

export { router as V1Router };
