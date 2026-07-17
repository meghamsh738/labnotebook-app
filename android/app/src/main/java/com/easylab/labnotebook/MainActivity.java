package com.easylab.labnotebook;

import android.content.Intent;
import android.os.Bundle;
import androidx.activity.ComponentActivity;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.lifecycle.ViewModelProvider;

public class MainActivity extends ComponentActivity {
    private NativeAuthViewModel authViewModel;
    private NativeShareViewModel shareViewModel;
    private final ActivityResultLauncher<IntentSenderRequest> authorizationLauncher = registerForActivityResult(
        new ActivityResultContracts.StartIntentSenderForResult(),
        result -> {
            if (authViewModel != null) {
                authViewModel.getActivityHost().onResult(result.getResultCode(), result.getData());
            }
        }
    );

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        authViewModel = new ViewModelProvider(this).get(NativeAuthViewModel.class);
        shareViewModel = new ViewModelProvider(this).get(NativeShareViewModel.class);
        shareViewModel.acceptIntent(getIntent(), false);
        authViewModel.getActivityHost().attach(this, request -> {
            authorizationLauncher.launch(request);
            return kotlin.Unit.INSTANCE;
        });
        NativeContent.install(this, authViewModel, shareViewModel);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (shareViewModel != null) {
            shareViewModel.acceptIntent(intent, true);
        }
    }

    @Override
    protected void onDestroy() {
        if (authViewModel != null) {
            authViewModel.getActivityHost().detach(this);
        }
        super.onDestroy();
    }
}
