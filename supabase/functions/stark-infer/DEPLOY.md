# stark-infer deployment (human steps — nothing here runs automatically)

The Edge Function needs exactly one secret. The actual key value is
never written anywhere in this repository.

## 1. Link the project (once per machine)

```sh
supabase login
supabase link --project-ref YOUR_PROJECT_REF
```

`YOUR_PROJECT_REF` is the subdomain of `https://YOUR_PROJECT_REF.supabase.co`
(the same URL already configured as `SUPABASE_URL` for desktop auth).

## 2. Set the OpenRouter secret

```sh
supabase secrets set OPENROUTER_API_KEY=...
```

Verify without revealing the value:

```sh
supabase secrets list
```

`OPENROUTER_API_KEY` must be listed. Get the key value from the
OpenRouter dashboard (Keys page); fund/limit it there — hackathon
spend is controlled by the OpenRouter key budget, not by durable
per-user quotas (intentionally out of scope tonight).

## 3. Deploy the function

```sh
supabase functions deploy stark-infer
```

Expected output ends with a deployed-function URL containing
`/functions/v1/stark-infer`.

## 4. Verify

```sh
supabase functions list
```

`stark-infer` must be listed. Then, signed in to STARK on desktop,
send any message with a STARK Free model selected: the first real
answer proves the full chain (desktop → function → OpenRouter).

An unauthenticated probe must fail closed:

```sh
curl -X POST https://YOUR_PROJECT_REF.supabase.co/functions/v1/stark-infer \
  -H "Content-Type: application/json" \
  -d '{"model":"builtin:gpt-5.6-luna","messages":[]}'
```

Expected: HTTP 401 `{"error":{"code":"sign_in_required"}}`.
