import base64
import hashlib
import json
import secrets
from datetime import timedelta
from urllib.parse import urlencode, urlsplit

from django.conf import settings
from django.contrib.auth import authenticate
from django.http import JsonResponse
from django.shortcuts import redirect, render
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_http_methods, require_POST

from .models import McpAccessToken, McpAuthorizationCode, McpOAuthClient


ALL_SCOPES = {"crm.read", "crm.write", "crm.admin"}


def canonical_resource(request):
    return request.build_absolute_uri("/api/mcp/").rstrip("/")


def issuer(request):
    return request.build_absolute_uri("/").rstrip("/")


def _json_body(request):
    try:
        return json.loads(request.body.decode("utf-8") or "{}")
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {}


def _allowed_redirect(uri):
    parsed = urlsplit(str(uri or ""))
    if parsed.scheme == "https" and parsed.hostname == "chatgpt.com":
        return parsed.path.startswith("/connector/") or parsed.path == "/connector_platform_oauth_redirect"
    return settings.DEBUG and parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost"}


def _scopes_for(user, raw_scope):
    requested = set(str(raw_scope or "crm.read crm.write").split()) & ALL_SCOPES
    allowed = {"crm.read", "crm.write"}
    if user.is_admin():
        allowed.add("crm.admin")
    return " ".join(sorted(requested & allowed))


@require_GET
def protected_resource_metadata(request):
    resource = canonical_resource(request)
    return JsonResponse({
        "resource": resource,
        "authorization_servers": [issuer(request)],
        "scopes_supported": sorted(ALL_SCOPES),
        "bearer_methods_supported": ["header"],
    })


@require_GET
def authorization_server_metadata(request):
    base = issuer(request)
    return JsonResponse({
        "issuer": base,
        "authorization_endpoint": f"{base}/api/mcp/oauth/authorize/",
        "token_endpoint": f"{base}/api/mcp/oauth/token/",
        "registration_endpoint": f"{base}/api/mcp/oauth/register/",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
        "scopes_supported": sorted(ALL_SCOPES),
        "authorization_response_iss_parameter_supported": True,
    })


@csrf_exempt
@require_POST
def register_client(request):
    payload = _json_body(request)
    redirect_uris = payload.get("redirect_uris") or []
    if not redirect_uris or any(not _allowed_redirect(value) for value in redirect_uris):
        return JsonResponse({"error": "invalid_redirect_uri"}, status=400)
    if payload.get("token_endpoint_auth_method", "none") != "none":
        return JsonResponse({"error": "invalid_client_metadata"}, status=400)
    client = McpOAuthClient.objects.create(
        client_id=f"mcp_{secrets.token_urlsafe(24)}",
        client_name=str(payload.get("client_name") or "ChatGPT / Codex")[:200],
        redirect_uris=list(dict.fromkeys(redirect_uris)),
    )
    return JsonResponse({
        "client_id": client.client_id,
        "client_name": client.client_name,
        "redirect_uris": client.redirect_uris,
        "token_endpoint_auth_method": "none",
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
    }, status=201)


def _authorize_params(source):
    return {key: str(source.get(key) or "") for key in (
        "client_id", "redirect_uri", "response_type", "scope", "state",
        "code_challenge", "code_challenge_method", "resource",
    )}


@require_http_methods(["GET", "POST"])
def authorize(request):
    params = _authorize_params(request.GET if request.method == "GET" else request.POST)
    try:
        client = McpOAuthClient.objects.get(client_id=params["client_id"])
    except McpOAuthClient.DoesNotExist:
        return JsonResponse({"error": "invalid_client"}, status=400)
    expected_resource = canonical_resource(request)
    if (
        params["response_type"] != "code"
        or params["redirect_uri"] not in client.redirect_uris
        or not _allowed_redirect(params["redirect_uri"])
        or params["code_challenge_method"] != "S256"
        or not params["code_challenge"]
        or params["resource"].rstrip("/") != expected_resource
    ):
        return JsonResponse({"error": "invalid_request"}, status=400)

    error_message = ""
    if request.method == "POST":
        user = authenticate(request, username=request.POST.get("username", ""), password=request.POST.get("password", ""))
        if user and user.is_active and request.POST.get("approve") == "yes":
            raw_code = secrets.token_urlsafe(48)
            McpAuthorizationCode.objects.create(
                code_hash=hashlib.sha256(raw_code.encode()).hexdigest(),
                client=client,
                user=user,
                redirect_uri=params["redirect_uri"],
                resource=expected_resource,
                scope=_scopes_for(user, params["scope"]),
                code_challenge=params["code_challenge"],
                expires_at=timezone.now() + timedelta(minutes=5),
            )
            query = {"code": raw_code, "state": params["state"], "iss": issuer(request)}
            return redirect(f"{params['redirect_uri']}?{urlencode(query)}")
        error_message = "Неверный логин или пароль CRM."
    return render(request, "crm_app/mcp_authorize.html", {
        "params": params,
        "client_name": client.client_name,
        "error_message": error_message,
    })


def _pkce_matches(verifier, challenge):
    value = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    return secrets.compare_digest(value, challenge)


def _token_response(record, raw_access, raw_refresh):
    return JsonResponse({
        "access_token": raw_access,
        "token_type": "Bearer",
        "expires_in": int((record.expires_at - timezone.now()).total_seconds()),
        "refresh_token": raw_refresh,
        "scope": record.scope,
    })


@csrf_exempt
@require_POST
def token(request):
    grant_type = request.POST.get("grant_type", "")
    client_id = request.POST.get("client_id", "")
    try:
        client = McpOAuthClient.objects.get(client_id=client_id)
    except McpOAuthClient.DoesNotExist:
        return JsonResponse({"error": "invalid_client"}, status=401)

    if grant_type == "authorization_code":
        raw_code = request.POST.get("code", "")
        try:
            code = McpAuthorizationCode.objects.select_related("user").get(
                code_hash=hashlib.sha256(raw_code.encode()).hexdigest(), client=client,
            )
        except McpAuthorizationCode.DoesNotExist:
            return JsonResponse({"error": "invalid_grant"}, status=400)
        if code.used_at or code.expires_at <= timezone.now() or code.redirect_uri != request.POST.get("redirect_uri", ""):
            return JsonResponse({"error": "invalid_grant"}, status=400)
        if request.POST.get("resource", "").rstrip("/") != code.resource.rstrip("/"):
            return JsonResponse({"error": "invalid_target"}, status=400)
        if not _pkce_matches(request.POST.get("code_verifier", ""), code.code_challenge):
            return JsonResponse({"error": "invalid_grant"}, status=400)
        code.used_at = timezone.now()
        code.save(update_fields=["used_at"])
        user, scope, resource = code.user, code.scope, code.resource
    elif grant_type == "refresh_token":
        raw_old_refresh = request.POST.get("refresh_token", "")
        try:
            old = McpAccessToken.objects.select_related("user").get(
                refresh_token_hash=McpAccessToken.hash_token(raw_old_refresh), client=client,
            )
        except McpAccessToken.DoesNotExist:
            return JsonResponse({"error": "invalid_grant"}, status=400)
        if old.revoked_at or old.refresh_expires_at <= timezone.now():
            return JsonResponse({"error": "invalid_grant"}, status=400)
        old.revoked_at = timezone.now()
        old.save(update_fields=["revoked_at"])
        user, scope, resource = old.user, old.scope, old.resource
    else:
        return JsonResponse({"error": "unsupported_grant_type"}, status=400)

    raw_access = secrets.token_urlsafe(48)
    raw_refresh = secrets.token_urlsafe(48)
    record = McpAccessToken.objects.create(
        access_token_hash=McpAccessToken.hash_token(raw_access),
        refresh_token_hash=McpAccessToken.hash_token(raw_refresh),
        client=client,
        user=user,
        resource=resource,
        scope=scope,
        expires_at=timezone.now() + timedelta(hours=8),
        refresh_expires_at=timezone.now() + timedelta(days=30),
    )
    return _token_response(record, raw_access, raw_refresh)


def authenticate_mcp_request(request):
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        return None
    token_value = header.removeprefix("Bearer ").strip()
    try:
        token_record = McpAccessToken.objects.select_related("user").get(
            access_token_hash=McpAccessToken.hash_token(token_value),
        )
    except McpAccessToken.DoesNotExist:
        return None
    if not token_record.is_active() or token_record.resource.rstrip("/") != canonical_resource(request):
        return None
    return token_record
