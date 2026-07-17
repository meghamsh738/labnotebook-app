package com.easylab.labnotebook.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

@Composable
internal fun NewProtocolForm(
    onDismiss: () -> Unit,
    onCreate: (String, ProtocolTemplate) -> Unit,
) {
    var title by remember { mutableStateOf("") }
    LazyColumn(
        modifier = Modifier.fillMaxSize().testTag("protocol-create-form"),
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onDismiss) {
                    Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back to protocols")
                }
                Column(Modifier.weight(1f)) {
                    Text(
                        "New protocol",
                        style = MaterialTheme.typography.headlineSmall,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.semantics { heading() },
                    )
                    Text(
                        "Choose how you want to begin.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Text("You can add or rename sections later.")
                OutlinedTextField(
                    value = title,
                    onValueChange = { if (it.length <= 240) title = it },
                    label = { Text("Protocol title") },
                    placeholder = { Text("Untitled protocol") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth().testTag("protocol-create-title"),
                )
                Button(
                    onClick = { onCreate(title, ProtocolTemplate.Guided) },
                    modifier = Modifier.fillMaxWidth().testTag("protocol-create-guided"),
                ) { Text("Use guided template") }
                OutlinedButton(
                    onClick = { onCreate(title, ProtocolTemplate.Blank) },
                    modifier = Modifier.fillMaxWidth().testTag("protocol-create-blank"),
                ) { Text("Create blank") }
                TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) { Text("Cancel") }
            }
        }
    }
}
