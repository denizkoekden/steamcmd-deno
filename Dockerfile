# Use the official Deno 2.0 image from DockerHub
FROM denoland/deno:2.0.0

# The port that your application listens to.
EXPOSE 8000

# Set the working directory inside the container.
WORKDIR /app

# Prefer not to run as root.
USER deno

# Copy the dependency file (if you have one, e.g., deps.ts for external modules).
# If not, you can remove this part.
COPY deps.ts .
RUN deno cache deps.ts

# Copy all the application files to the working directory.
COPY . .

# Cache the main application to avoid recompilation on every startup.
RUN deno cache app.ts

# Set the command to run the Deno app, allowing necessary permissions.
CMD ["deno", "task", "start"]
