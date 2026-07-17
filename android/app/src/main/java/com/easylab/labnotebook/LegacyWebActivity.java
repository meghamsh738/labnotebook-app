package com.easylab.labnotebook;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

/** Temporary Capacitor host retained until native sync reaches contract parity. */
public class LegacyWebActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(GoogleDriveAuthPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
