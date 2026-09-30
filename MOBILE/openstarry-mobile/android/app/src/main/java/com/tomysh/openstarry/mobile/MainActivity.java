package com.tomysh.openstarry.mobile;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AgentHttpPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
