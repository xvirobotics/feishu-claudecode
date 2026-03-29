import SwiftUI
import MarkdownUI

extension MarkdownUI.Theme {
    static var nexus: Theme {
        Theme()
        .text {
            ForegroundColor(NexusColors.text0)
            FontSize(NexusFontScale.scaled(15))
        }
        .code {
            FontFamilyVariant(.monospaced)
            FontSize(NexusFontScale.scaled(13))
            ForegroundColor(NexusColors.text1)
            BackgroundColor(NexusColors.codeBg)
        }
        .codeBlock { configuration in
            VStack(spacing: 0) {
                // Header bar with language label and copy button
                HStack {
                    Text(configuration.language?.uppercased() ?? "CODE")
                        .font(NexusTypography.jetBrainsMono(size: 10))
                        .foregroundStyle(NexusColors.text3)
                        .tracking(1)
                    Spacer()
                    CopyCodeButton(code: configuration.content)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(NexusColors.surface1)

                Divider().background(NexusColors.glassBorder)

                // Code content
                ScrollView(.horizontal, showsIndicators: false) {
                    configuration.label
                        .markdownTextStyle {
                            FontFamilyVariant(.monospaced)
                            FontSize(NexusFontScale.scaled(13))
                            ForegroundColor(NexusColors.text1)
                        }
                        .padding(12)
                }
                .background(NexusColors.codeBg)
            }
            .clipShape(RoundedRectangle(cornerRadius: NexusRadius.md))
            .overlay(
                RoundedRectangle(cornerRadius: NexusRadius.md)
                    .stroke(NexusColors.glassBorder, lineWidth: 1)
            )
        }
        .link {
            ForegroundColor(NexusColors.accent)
        }
    }
}
