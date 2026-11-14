package app.eryon.identity.protocol;

import net.minecraft.network.RegistryByteBuf;
import net.minecraft.network.codec.PacketCodec;
import net.minecraft.network.codec.PacketCodecs;
import net.minecraft.network.packet.CustomPayload;
import net.minecraft.util.Identifier;

public final class IdentityPayloads {
    public static final int PROTOCOL_VERSION = 1;
    private static final String NAMESPACE = "eryon";

    private IdentityPayloads() {}

    public record Hello(int protocolVersion) implements CustomPayload {
        public static final Id<Hello> ID =
            new Id<>(Identifier.of(NAMESPACE, "identity_hello"));
        public static final PacketCodec<RegistryByteBuf, Hello> CODEC =
            PacketCodec.tuple(
                PacketCodecs.VAR_INT,
                Hello::protocolVersion,
                Hello::new
            );

        @Override
        public Id<? extends CustomPayload> getId() {
            return ID;
        }
    }

    public record State(String json) implements CustomPayload {
        public static final Id<State> ID =
            new Id<>(Identifier.of(NAMESPACE, "identity_state"));
        public static final PacketCodec<RegistryByteBuf, State> CODEC =
            PacketCodec.tuple(
                PacketCodecs.STRING,
                State::json,
                State::new
            );

        @Override
        public Id<? extends CustomPayload> getId() {
            return ID;
        }
    }
}
