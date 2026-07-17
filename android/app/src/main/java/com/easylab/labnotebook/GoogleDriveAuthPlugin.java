package com.easylab.labnotebook;

import android.accounts.Account;
import android.app.Activity;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.IntentSender;
import android.net.Uri;
import android.os.Bundle;
import android.text.TextUtils;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.api.identity.AuthorizationClient;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.auth.api.identity.RevokeAccessRequest;
import com.google.android.gms.auth.api.signin.GoogleSignInAccount;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.Scope;

import java.util.ArrayList;
import java.util.List;

@CapacitorPlugin(name = "GoogleDriveAuth", requestCodes = { 48173 })
public class GoogleDriveAuthPlugin extends Plugin {
    private static final int REQUEST_AUTHORIZE_DRIVE = 48173;
    private static final String DEFAULT_SCOPE = "openid email profile https://www.googleapis.com/auth/drive.file";

    private AuthorizationClient authorizationClient;
    private PluginCall pendingAuthorizeCall;
    private ArrayList<Scope> lastRequestedScopes = parseScopes(DEFAULT_SCOPE);
    private GoogleSignInAccount lastAccount;

    @Override
    public void load() {
        authorizationClient = Identity.getAuthorizationClient(getContext());
    }

    @PluginMethod
    public void requestAccessToken(PluginCall call) {
        ArrayList<Scope> requestedScopes = parseScopes(call.getString("scope", DEFAULT_SCOPE));
        if (requestedScopes.isEmpty()) {
            call.reject("Google Drive authorization requires at least one OAuth scope.");
            return;
        }
        lastRequestedScopes = requestedScopes;

        AuthorizationRequest authorizationRequest = AuthorizationRequest.builder()
            .setRequestedScopes(requestedScopes)
            .build();

        authorizationClient
            .authorize(authorizationRequest)
            .addOnSuccessListener(result -> {
                if (result.hasResolution()) {
                    launchAuthorizationIntent(call, result);
                    return;
                }
                resolveAuthorization(call, result);
            })
            .addOnFailureListener(error -> rejectAuthorization(call, error));
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        Account account = lastAccount != null ? lastAccount.getAccount() : null;
        if (account == null) {
            JSObject result = new JSObject();
            result.put("ok", true);
            result.put("message", "No native Google account was cached for this session.");
            call.resolve(result);
            return;
        }

        RevokeAccessRequest revokeAccessRequest = RevokeAccessRequest.builder()
            .setAccount(account)
            .setScopes(lastRequestedScopes)
            .build();

        authorizationClient
            .revokeAccess(revokeAccessRequest)
            .addOnSuccessListener(unused -> {
                lastAccount = null;
                JSObject result = new JSObject();
                result.put("ok", true);
                call.resolve(result);
            })
            .addOnFailureListener(error -> rejectAuthorization(call, error));
    }

    private void launchAuthorizationIntent(PluginCall call, AuthorizationResult result) {
        PendingIntent pendingIntent = result.getPendingIntent();
        if (pendingIntent == null) {
            call.reject("Google Drive authorization needs consent, but no consent intent was provided.");
            return;
        }

        pendingAuthorizeCall = call;
        try {
            getActivity().startIntentSenderForResult(
                pendingIntent.getIntentSender(),
                REQUEST_AUTHORIZE_DRIVE,
                null,
                0,
                0,
                0
            );
        } catch (IntentSender.SendIntentException error) {
            pendingAuthorizeCall = null;
            call.reject("Could not open Google Drive authorization.", error);
        }
    }

    @Override
    protected void handleOnActivityResult(int requestCode, int resultCode, Intent data) {
        super.handleOnActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_AUTHORIZE_DRIVE) {
            return;
        }

        PluginCall call = pendingAuthorizeCall;
        pendingAuthorizeCall = null;
        if (call == null) {
            return;
        }

        if (resultCode != Activity.RESULT_OK || data == null) {
            call.reject("Google Drive authorization was cancelled or the Android OAuth client is not registered for this app build.");
            return;
        }

        try {
            AuthorizationResult result = authorizationClient.getAuthorizationResultFromIntent(data);
            resolveAuthorization(call, result);
        } catch (ApiException error) {
            rejectAuthorization(call, error);
        }
    }

    private void resolveAuthorization(PluginCall call, AuthorizationResult authorizationResult) {
        String accessToken = authorizationResult.getAccessToken();
        if (TextUtils.isEmpty(accessToken)) {
            call.reject("Google Drive authorization completed without an access token.");
            return;
        }

        lastAccount = authorizationResult.toGoogleSignInAccount();

        JSObject result = new JSObject();
        result.put("accessToken", accessToken);
        result.put("tokenType", "Bearer");
        result.put("scope", TextUtils.join(" ", authorizationResult.getGrantedScopes()));

        Integer expiresIn = getExpiresIn(authorizationResult.getTokenResponseParams());
        if (expiresIn != null) {
            result.put("expiresIn", expiresIn);
        }

        JSObject account = accountToJson(lastAccount);
        if (account != null) {
            result.put("account", account);
        }

        call.resolve(result);
    }

    private void rejectAuthorization(PluginCall call, Exception error) {
        String message = error instanceof ApiException
            ? "Google Drive authorization failed (" + ((ApiException) error).getStatusCode() + ")."
            : "Google Drive authorization failed.";
        call.reject(message, error);
    }

    private static ArrayList<Scope> parseScopes(String scopeValue) {
        ArrayList<Scope> scopes = new ArrayList<>();
        String value = scopeValue == null || scopeValue.trim().isEmpty() ? DEFAULT_SCOPE : scopeValue;
        for (String scope : value.trim().split("\\s+")) {
            if (!scope.isEmpty()) {
                scopes.add(new Scope(scope));
            }
        }
        return scopes;
    }

    private static JSObject accountToJson(GoogleSignInAccount account) {
        if (account == null) {
            return null;
        }

        JSObject accountJson = new JSObject();
        accountJson.put("provider", "google");
        accountJson.put("email", account.getEmail());
        accountJson.put("name", account.getDisplayName());
        accountJson.put("subject", account.getId());
        Uri photoUrl = account.getPhotoUrl();
        if (photoUrl != null) {
            accountJson.put("picture", photoUrl.toString());
        }
        return accountJson;
    }

    private static Integer getExpiresIn(Bundle tokenResponseParams) {
        if (tokenResponseParams == null) {
            return null;
        }
        Object value = tokenResponseParams.get("expires_in");
        if (value instanceof Number) {
            return ((Number) value).intValue();
        }
        if (value instanceof String) {
            try {
                return Integer.parseInt((String) value);
            } catch (NumberFormatException ignored) {
                return null;
            }
        }
        return null;
    }
}
