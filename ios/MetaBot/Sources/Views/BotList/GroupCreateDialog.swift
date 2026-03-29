import SwiftUI

/// Dialog for creating a new bot group
struct GroupCreateDialog: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss

    @State private var groupName = ""
    @State private var selectedBots: Set<String> = []

    var body: some View {
        NavigationStack {
            Form {
                Section("Group Name") {
                    TextField("Enter group name", text: $groupName)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }

                Section("Select Bots (at least 2)") {
                    ForEach(appState.bots) { bot in
                        Button {
                            if selectedBots.contains(bot.name) {
                                selectedBots.remove(bot.name)
                            } else {
                                selectedBots.insert(bot.name)
                            }
                        } label: {
                            HStack {
                                GradientAvatar(name: bot.name, size: 32)
                                VStack(alignment: .leading) {
                                    Text(bot.name)
                                        .font(.subheadline.bold())
                                        .foregroundStyle(.primary)
                                    if let platform = bot.platform {
                                        Text(platform)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                                if selectedBots.contains(bot.name) {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundStyle(Color.accentColor)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("New Group")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        appState.createGroup(
                            name: groupName.trimmingCharacters(in: .whitespacesAndNewlines),
                            members: Array(selectedBots)
                        )
                        dismiss()
                    }
                    .disabled(groupName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || selectedBots.count < 2)
                }
            }
        }
    }
}
