package com.example.demo.controllers;

import java.io.IOException;

import javax.mail.MessagingException;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpSession;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Controller;
import org.springframework.ui.ModelMap;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;

import com.example.demo.service.LoginService;
import com.example.demo.service.Mailservice;

@Controller
public class LoginController {
	@Autowired
	LoginService loginService;
	
	@Autowired
	Mailservice mailService;
	
	@RequestMapping("/login")
	public String loginMessage(){
		return "login";
	}
	
	@RequestMapping("/validatelogin")
	public String dashboard(@RequestParam String username,@RequestParam String password,
			ModelMap model, HttpServletRequest request)throws MessagingException, IOException{
		model.put("username",username);
		String role = loginService.getRole(username, password);
		if (role != null) {
			HttpSession oldSession = request.getSession(false);
			if (oldSession != null) {
				oldSession.invalidate();
			}
			HttpSession session = request.getSession(true);
			session.setAttribute("username", username);
			session.setAttribute("role", role);
			mailService.sendEmail(username);
			return ("admin".equals(role) || "emp".equals(role)) ? "redirect:/staff" : "home";
		}
		return "login";
	}
}
