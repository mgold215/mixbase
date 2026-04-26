// src/app/api/iap/apple/verify/route.ts
// Verifies an Apple in-app purchase transaction via the App Store Server API.
// iOS sends the transactionId + productId after a successful StoreKit 2 purchase.
// Server generates a JWT with our App Store Connect API key, calls Apple to verify,
// then updates the user's subscription tier in Supabase.

import { NextRequest, NextResponse } from 'next/server'
import { createSign } from 'crypto'
import { setSubscriptionTier, SubscriptionTier } from '@/lib/tier'

const PRODUCT_TIER_MAP: Record<string, SubscriptionTier> = {
  'com.moodmixformat.mixbase.pro.monthly':    'pro',
  'com.moodmixformat.mixbase.studio.monthly': 'studio',
}

// Generate a signed JWT for the App Store Server API using our App Store Connect API key.
// Apple requires ES256 (ECDSA P-256) signing.
function generateAppleJWT(): string {
  const keyId    = process.env.APPLE_IAP_KEY_ID!
  const issuerId = process.env.APPLE_IAP_ISSUER_ID!
  const bundleId = process.env.APPLE_APP_BUNDLE_ID!
  // The .p8 key is stored base64-encoded in the env var
  const privateKeyPem = Buffer.from(process.env.APPLE_IAP_PRIVATE_KEY!, 'base64').toString('utf8')

  const now = Math.floor(Date.now() / 1000)
  const header  = Buffer.from(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    iss: issuerId,
    iat: now,
    exp: now + 1200,
    aud: 'appstoreconnect-v1',
    bid: bundleId,
  })).toString('base64url')

  const signingInput = `${header}.${payload}`
  const sign = createSign('SHA256')
  sign.update(signingInput)
  // IEEE P1363 format is required for ES256 JWTs (not ASN.1 DER)
  const signature = sign.sign({ key: privateKeyPem, dsaEncoding: 'ieee-p1363' }, 'base64url')

  return `${signingInput}.${signature}`
}

// Base64url-decode the JWS payload without full signature verification.
// This is safe because we fetched the JWS directly from Apple's API.
function decodeJWSPayload(jws: string): Record<string, unknown> {
  const parts = jws.split('.')
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
}

export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { transactionId, productId } = await request.json()
  if (!transactionId || !productId) {
    return NextResponse.json({ error: 'transactionId and productId are required' }, { status: 400 })
  }

  const tier = PRODUCT_TIER_MAP[productId]
  if (!tier) {
    return NextResponse.json({ error: `Unknown productId: ${productId}` }, { status: 400 })
  }

  if (!process.env.APPLE_IAP_KEY_ID || !process.env.APPLE_IAP_ISSUER_ID || !process.env.APPLE_APP_BUNDLE_ID || !process.env.APPLE_IAP_PRIVATE_KEY) {
    return NextResponse.json({ error: 'Apple IAP not configured' }, { status: 503 })
  }

  // Verify with Apple App Store Server API
  const jwt = generateAppleJWT()
  const appleRes = await fetch(
    `https://api.storekit.itunes.apple.com/inApps/v2/transactions/${transactionId}`,
    { headers: { Authorization: `Bearer ${jwt}` } }
  )

  if (!appleRes.ok) {
    const text = await appleRes.text()
    console.error('[apple-iap] Verification failed:', appleRes.status, text)
    return NextResponse.json({ error: 'Transaction verification failed' }, { status: 402 })
  }

  const { signedTransactionInfo } = await appleRes.json()
  const txData = decodeJWSPayload(signedTransactionInfo)

  // Confirm the product matches
  if (txData.productId !== productId) {
    return NextResponse.json({ error: 'Product ID mismatch' }, { status: 400 })
  }

  const expiresAt = txData.expiresDate
    ? new Date(txData.expiresDate as number).toISOString()
    : null

  await setSubscriptionTier(userId, tier, 'apple', {
    apple_original_transaction_id: txData.originalTransactionId as string,
    subscription_expires_at: expiresAt,
  })

  return NextResponse.json({ tier })
}
