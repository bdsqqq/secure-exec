FROM alpine:3.19
RUN apk add --no-cache openssh \
 && ssh-keygen -A \
 && adduser -D -s /bin/sh testuser \
 && echo "testuser:testpass" | chpasswd \
 && sed -i 's/^#PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config \
 && sed -i 's/^#PermitEmptyPasswords.*/PermitEmptyPasswords no/' /etc/ssh/sshd_config \
 && mkdir -p /home/testuser/upload
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
